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
// 触发:POST /api/cron_alert   header: X-Cron-Key: <CRON_KEY>   body:{ nick?:'仅跑某账号' }
//   建议交易时段每 1~2 分钟拨测一次(与前端 15s 轮询相比,后台粒度粗但足够抓到关键价位)。

import { applyCors, preflight } from './_lib.js';
import { listAllAccounts, writeAccount } from './account.js';
import quoteHandler from './quote.js';
import { sendPush, pushConfigured } from './_push_send.js';

const OP_LABEL = { gte: '≥', lte: '≤' };

// —— 与前端 alertStore.describeAlert 同口径 ——
function describeAlert(a) {
  if (a.type === 'limitup') return '临近涨停(涨幅≥9.5%)';
  if (a.type === 'limitdown') return '临近跌停(跌幅≥9.5%)';
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
  const active = alerts.filter((a) => a && a.enabled && !a.triggeredAt);
  if (!active.length || !subs.length) return { changed: false, hits: 0, sent: 0 };

  const codes = [...new Set(active.map((a) => a.code))];
  const quoteMap = await invokeQuote(codes);

  let changed = false, hits = 0, sent = 0;
  const dead = new Set();
  for (const a of active) {
    const msg = hit(a, quoteMap[a.code]);
    if (!msg) continue;
    hits++;
    const title = `⚡ 预警触发 · ${a.name || a.code}`;
    const body = `${describeAlert(a)}｜${msg}`;
    const r = await sendPush(subs, { title, body, code: a.code, tag: 'alert-' + a.id, url: '/' });
    sent += r.sent;
    for (const ep of r.deadEndpoints) dead.add(ep);
    // 标记已触发(与前端同口径:触发后自动停用防重复)
    a.triggeredAt = Date.now(); a.triggeredMsg = msg; a.enabled = false;
    changed = true;
  }
  if (dead.size) { data.pushSubs = subs.filter((s) => !dead.has(s.endpoint)); changed = true; }
  return { changed, hits, sent };
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
  try {
    let accounts = await listAllAccounts();
    if (onlyNick) accounts = accounts.filter((a) => a.nick === onlyNick);
    let totalHits = 0, totalSent = 0, touched = 0;
    for (const acc of accounts) {
      let r;
      try { r = await processAccount(acc); } catch (e) { r = { changed: false, hits: 0, sent: 0, error: String(e.message || e) }; }
      if (r.changed) { touched++; try { await writeAccount(acc); } catch { /* ignore */ } }
      totalHits += r.hits || 0; totalSent += r.sent || 0;
    }
    return res.end(JSON.stringify({ ok: true, accounts: accounts.length, hits: totalHits, sent: totalSent, touched, elapsedMs: Date.now() - started }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
  }
}
