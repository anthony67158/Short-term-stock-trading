// ============ 云端定时「盯盘预警」评估 + Web Push 下发(脱离浏览器) ============
// 背景:原预警只在浏览器标签打开时由前端 alertStore.evaluate 跑;关页面/切后台就停了。
//   本 handler 把「命中判定 + 推送」搬到服务端:定时(交易时段 curl 命中)遍历所有账号,
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
// 触发:POST /api/cron_alert   header: X-Cron-Key: <CRON_KEY>
//   body:{ nick?:'仅跑某账号', roundMs?, budgetMs? }
//   本 handler 内部自循环:每分钟被 cron 触发一次,单次内按 roundMs(默认 8s)连续评估多轮直到
//   耗尽 budgetMs(默认 55s)。故有效监控频率 ≈ 8 秒级,不再受 GitHub Actions cron 1 分钟粒度限制。

import { applyCors, preflight } from './_lib.js';
import { listAllAccounts, writeAccount } from './account.js';
import quoteHandler from './quote.js';
import { sendPush, pushConfigured } from './_push_send.js';
import { ensureConfig } from './_llm_config.js';
import { judgeConfirmation, sideOf } from './_confirm.js';
import { t1StatusOf } from './_portfolio.js';
import { collectOutcomeSnapshots, duplicateSmartAlerts } from '../shared/confirmPolicy.js';
import { applyT1ToAlert } from '../shared/t1AdvicePolicy.js';

const OP_LABEL = { gte: '≥', lte: '≤' };

// 单账号单轮「智能确认(LLM judge)」调用上限:watching 态预警很多时,若逐条 judge 会烧光 token/超时,
// 拖垮整轮拨测。超出预算的 watching 预警本轮跳过(维持 watching,下轮再判),保证每轮有界收敛。
const JUDGE_BUDGET_PER_ROUND = 4;
const JUDGE_INTERVAL_MS = { buy: 45000, sell: 30000, stop: 20000 };
const WATCHING_MAX_MS = 90 * 60 * 1000;

// 交易语义 → 强提示动作词(与 _confirm.sideOf 的 buy/sell/stop 对齐)
const ACTION_ZH = { buy: '买入', sell: '卖出', stop: '止损离场' };

// —— 与前端 alertStore.describeAlert 同口径 ——
function describeAlert(a) {
  if (a.type === 'limitup') return '临近涨停(涨幅≥9.5%)';
  if (a.type === 'limitdown') return '临近跌停(跌幅≥9.5%)';
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

// —— 与前端 alertStore.confirmHint 同口径:到操作点的「先确认再动手」提示 ——
function confirmHint(a) {
  if (!a || a.type !== 'price') return '';
  if (a.actKind === 'add') {
    const tail = a.timing ? '：' + a.timing : '：等分时止跌/站回均价线再补，别追一瞬价。';
    return '\n🎯到操作点=开始盯，先确认再动手' + tail + ' 详情见AI建议「到价后怎么做」。';
  }
  if (a.actKind === 'reduce') {
    const tail = a.timing ? '：' + a.timing : '：反弹放量滞涨/冲高回落再减，锁定部分利润即可。';
    return '\n🎯到操作点=开始盯，先确认再动手' + tail + ' 详情见AI建议「到价后怎么做」。';
  }
  const note = a.note || '';
  if (/止损/.test(note)) return '\n⚠️到价=开始盯，别急砍：确认是否放量/收盘跌破，只是瞬时插针又拉回可先缓一手。';
  if (/止盈/.test(note)) return '\n💡到价=开始盯，别一次清光：可先减一部分锁利，剩余用移动止盈跟着走。';
  if (/买点/.test(note)) return '\n💡到价=开始盯，别追一瞬价：等缩量企稳/站回均线再进。';
  return '';
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
    case 'limitup':
      return (q.pct != null && q.pct >= 9.5) ? `${q.name || ''} 涨幅 ${Number(q.pct).toFixed(2)}%,临近/触及涨停` : null;
    case 'limitdown':
      return (q.pct != null && q.pct <= -9.5) ? `${q.name || ''} 跌幅 ${Number(q.pct).toFixed(2)}%,临近/触及跌停` : null;
    default:
      return null;
  }
}

// 进程内调用 quote handler 取实时报价 map(code→q)
function invokeQuote(codes) {
  return new Promise((resolve) => {
    const chunks = [];
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
      if (done) return; done = true;
      let out = p;
      if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* keep */ } }
      if (out == null && chunks.length) { try { out = JSON.parse(chunks.join('')); } catch { out = null; } }
      const map = {};
      for (const it of (out && out.list) || []) if (it && it.code) map[it.code] = it;
      resolve(map);
    }
    try {
      const r = quoteHandler({ method: 'GET', query: { codes: codes.join(',') }, headers: {} }, res);
      if (r && typeof r.then === 'function') r.catch(() => finish(null));
    } catch { finish(null); }
    setTimeout(() => finish(null), 12000);
  });
}

async function processAccount(acc) {
  const data = acc.data || {};
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];
  const subs = Array.isArray(data.pushSubs) ? data.pushSubs : [];
  const adviceMap = (data.advice && typeof data.advice === 'object') ? data.advice : {};
  // 智能确认默认开启;账号显式关掉(settings.smartConfirm===false)则回退「见价即强推」旧行为。
  const smartOn = !(data.settings && data.settings.smartConfirm === false);
  let changed = false, hits = 0, sent = 0;

  // 同股、同方向、同价位的 AI 预警只保留信息更完整的一条，避免重复弱提醒和重复 Judge。
  for (const duplicate of duplicateSmartAlerts(alerts, sideOf)) {
    const alert = alerts.find((item) => item.id === duplicate.id);
    if (!alert) continue;
    alert.enabled = false;
    alert.phase = 'superseded';
    alert.supersededBy = duplicate.primaryId;
    alert.triggeredMsg = '与同价同方向智能预警合并';
    changed = true;
  }

  // armed/watching 均需处理:enabled && 未最终触发(confirmed)
  const active = alerts.filter((a) => a && a.enabled && !a.triggeredAt);
  const outcomePending = alerts.filter((alert) =>
    alert?.phase === 'confirmed' &&
    alert.triggeredAt &&
    Date.now() - alert.triggeredAt <= 45 * 60 * 1000 &&
    !alert.judgeOutcomes?.m30
  );
  const sidePriority = { stop: 3, sell: 2, buy: 1 };
  const activeForPush = (subs.length ? active : []).slice().sort((a, b) => {
    const aWatching = a.phase === 'watching' ? 1 : 0;
    const bWatching = b.phase === 'watching' ? 1 : 0;
    if (aWatching !== bWatching) return bWatching - aWatching;
    const sideDiff = (sidePriority[sideOf(b)] || 0) - (sidePriority[sideOf(a)] || 0);
    if (sideDiff) return sideDiff;
    return (a.lastJudgeAt || 0) - (b.lastJudgeAt || 0);
  });
  if (!activeForPush.length && !outcomePending.length) return { changed, hits, sent, judgeCalls: 0 };

  const codes = [...new Set([...activeForPush, ...outcomePending].map((a) => a.code))];
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
    const judgeEvent = (data.decisionLog || []).find((event) =>
      event?.kind === 'judge' && event.alertId === alert.id
    );
    if (judgeEvent) judgeEvent.judgeOutcomes = outcome.outcomes;
    changed = true;
  }

  // 该预警是否走智能二段确认:仅对【价位类 + AI 派生(带 phase 字段)】启用;
  //   手动到价/涨跌幅/量比/涨跌停等 → 无 phase → 老逻辑(见价即强推)。
  const isSmart = (a) => smartOn && a.type === 'price' && !!a.phase && a.phase !== 'confirmed' && a.phase !== 'invalid';

  for (const storedAlert of activeForPush) {
    const t1Alert = applyT1ToAlert(
      storedAlert,
      t1StatusOf(data.holding || [], data.closed || [], storedAlert.code),
    );
    if (JSON.stringify(t1Alert) !== JSON.stringify(storedAlert)) {
      Object.assign(storedAlert, t1Alert);
      changed = true;
    }
    const a = storedAlert;
    if (a.t1Blocked) continue;
    const q = quoteMap[a.code];
    if (!isSmart(a)) {
      // —— 老逻辑:命中即强推并停用(向后兼容,不受智能确认影响)——
      const msg = hit(a, q);
      if (!msg) continue;
      hits++;
      const actLabel = a.actKind === 'add' ? '补仓' : (a.actKind === 'reduce' ? '减仓' : '');
      const title = actLabel ? `🎯 到${actLabel}操作点 · ${a.name || a.code}` : `⚡ 预警触发 · ${a.name || a.code}`;
      const body = `${describeAlert(a)}｜${msg}${confirmHint(a)}`;
      collectDead(await sendPush(subs, { title, body, code: a.code, tag: 'alert-' + a.id, url: '/' }));
      a.triggeredAt = Date.now(); a.triggeredMsg = msg; a.enabled = false;
      changed = true;
      continue;
    }

    // —— 智能二段确认 ——
    if (a.phase === 'armed' || !a.phase) {
      // 阶段一:价格触及关键价位 → 发【弱提醒】,进入「观察确认中」,继续监控真正时机(不停用)
      const msg = hit(a, q);
      if (!msg) continue;
      hits++;
      const side = sideOf(a);
      const actZh = ACTION_ZH[side] || '操作';
      const title = `👀 到点位·观察确认中 · ${a.name || a.code}`;
      const body = `${describeAlert(a)}｜${msg}\n⏳已到${actZh}价位,但「到价≠立刻动手」。系统正在盯盘确认真正时机,确认后会再发一次「✅ 可以${actZh}」的强提示,先别急。`;
      collectDead(await sendPush(subs, { title, body, code: a.code, tag: 'watch-' + a.id, url: '/' }));
      a.phase = 'watching'; a.watchingAt = Date.now(); a.watchingPrice = Number(q?.price) || null; a.watchingMsg = msg;
      changed = true;
      continue;
    }

    if (a.phase === 'watching') {
      const now = Date.now();
      const side = sideOf(a);
      const age = a.watchingAt ? now - a.watchingAt : 0;
      // 长时间没有形成确认且价格已离开触发区：重新武装，等待下一次真正触价。
      if (age > WATCHING_MAX_MS && !hit(a, q)) {
        a.phase = 'armed';
        a.watchingAt = null;
        a.watchingPrice = null;
        a.watchingMsg = '';
        a.lastJudgeAt = null;
        changed = true;
        continue;
      }
      // 阶段二:调用智能确认闸门,判定真正交易时机是否到。
      // ★预算护栏:本轮 judge 调用达上限 → 跳过(维持 watching,下轮再判),避免 watching 堆积时烧光 token/超时。
      if (judgeCalls >= JUDGE_BUDGET_PER_ROUND) continue;
      // 现价缺失(接口异常/休市返回空)时不判定,省一次无谓的 judge 调用。
      if (!q || q.price == null || !(Number(q.price) > 0)) continue;
      if (a.lastJudgeAt && now - a.lastJudgeAt < (JUDGE_INTERVAL_MS[side] || 45000)) continue;
      judgeCalls++;
      let verdict = null;
      try {
        verdict = await judgeConfirmation({ alert: a, name: a.name, advice: adviceMap[a.code] && adviceMap[a.code].advice, quote: q });
      } catch (e) { verdict = { decision: 'wait', reason: '确认判定异常:' + String(e && e.message || e) }; }
      if (!verdict) continue;
      a.lastJudgeAt = now;
      a.lastJudgeDecision = verdict.decision;
      a.lastJudgeConfidence = verdict.confidence ?? null;
      a.lastJudgePolicy = verdict.policy || null;
      a.lastJudgePrice = Number(q.price);
      a.judgeCount = (Number(a.judgeCount) || 0) + 1;
      changed = true;
      if (verdict.decision === 'confirm') {
        hits++;
        const decisionSide = verdict.side || side;
        const actZh = ACTION_ZH[decisionSide] || '操作';
        const conf = verdict.confidence != null ? `(把握${verdict.confidence})` : '';
        const title = `✅ 可以${actZh} · ${a.name || a.code}`;
        const body = `${describeAlert(a)}｜确认时机已到${conf}\n📌${verdict.reason || '多项信号共振确认'}`;
        collectDead(await sendPush(subs, { title, body, code: a.code, tag: 'confirm-' + a.id, url: '/' }));
        a.phase = 'confirmed'; a.triggeredAt = Date.now(); a.triggeredMsg = `确认${actZh}:${verdict.reason || ''}`; a.enabled = false;
        a.decisionPrice = Number(q.price);
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
          judgeOutcomes: {},
        };
        data.decisionLog = [
          judgeEvent,
          ...(data.decisionLog || []).filter((event) => event?.id !== judgeEvent.id),
        ].slice(0, 1000);
        changed = true;
      } else if (verdict.decision === 'invalid') {
        // 交易逻辑已被破坏(如买点却已放量跌破失效价)→ 撤下该点位,发一次说明,不再纠缠
        const decisionSide = verdict.side || side;
        const actZh = ACTION_ZH[decisionSide] || '操作';
        const title = `⛔ 已失效·暂不${actZh} · ${a.name || a.code}`;
        const body = `${describeAlert(a)}｜原${actZh}逻辑已被破坏\n📌${verdict.reason || '关键条件已破坏,建议重新评估'}`;
        collectDead(await sendPush(subs, { title, body, code: a.code, tag: 'invalid-' + a.id, url: '/' }));
        a.phase = 'invalid'; a.triggeredAt = Date.now(); a.triggeredMsg = `已失效:${verdict.reason || ''}`; a.enabled = false;
        changed = true;
      }
      // wait → 维持 watching,静默继续观察
    }
  }
  if (dead.size) { data.pushSubs = subs.filter((s) => !dead.has(s.endpoint)); changed = true; }
  return { changed, hits, sent, judgeCalls };
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
  if (!pushConfigured()) {
    return res.end(JSON.stringify({ ok: false, error: 'VAPID 未配置(缺 VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)' }));
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onlyNick = body.nick ? String(body.nick) : null;
  const started = Date.now();

  // —— 内部自循环:GitHub Actions cron 最细只有 1 分钟粒度,想「更快」就让单次拨测在函数内
  //    连续跑多轮。每轮重新拉账号(拿最新 phase/新加的预警)→评估→写回,轮间 sleep 后再来一轮,
  //    直到耗尽时间预算。这样有效监控频率 = 轮间隔(默认 8s),不再受 cron 粒度限制。
  //    可调(env 优先,body 可临时覆盖):
  //      CRON_ALERT_ROUND_MS   轮间隔毫秒(默认 8000,下限 3000 防烧 token)
  //      CRON_ALERT_BUDGET_MS  单次总预算毫秒(默认 55000,须 < workflow curl -m 与 FC timeout)
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

    let totalHits = 0, totalSent = 0, totalJudgeCalls = 0, touched = 0, rounds = 0, lastAccounts = 0;
    // 至少跑 1 轮;之后只要「距开始 + 一轮最坏耗时」仍在预算内就继续。
    while (true) {
      rounds++;
      let accounts = await listAllAccounts();
      if (onlyNick) accounts = accounts.filter((a) => a.nick === onlyNick);
      lastAccounts = accounts.length;
      for (const acc of accounts) {
        let r;
        try { r = await processAccount(acc); } catch (e) { r = { changed: false, hits: 0, sent: 0, error: String(e.message || e) }; }
        if (r.changed) { touched++; try { await writeAccount(acc); } catch { /* ignore */ } }
        totalHits += r.hits || 0; totalSent += r.sent || 0;
        totalJudgeCalls += r.judgeCalls || 0;
      }
      // 预算判断:若「再睡一轮 + 预留一轮评估余量」会超预算,则收尾退出。
      const elapsed = Date.now() - started;
      if (elapsed + roundMs + 3000 >= budgetMs) break;
      await sleep(roundMs);
    }
    return res.end(JSON.stringify({ ok: true, accounts: lastAccounts, hits: totalHits, sent: totalSent, judgeCalls: totalJudgeCalls, touched, rounds, roundMs, elapsedMs: Date.now() - started }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
  }
}
