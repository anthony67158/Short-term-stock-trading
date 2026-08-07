// ============ 云端「AI 操作建议」任务队列 + 并发池 + 单 Worker 锁(脱离浏览器,跨端共享)============
// 演进(相对旧版串行 cron_advice):
//   旧版:一次 FC 请求内【串行】生成指定 codes,进度写 batchProgress。任务不持久 → FC 崩/超时即丢,
//         无状态/无重试/无取消,点两次起两份。
//   新版:任务沉到账号 data.jobs(OSS 持久,见 _jobs.js),服务端为唯一权威源:
//         · 并发池:同一时刻最多 CONCURRENCY(默认3)只在跑,上限由"running 且租约未过期"计数强制;
//           因所有设备都汇入同一张 OSS 表 + 单 Worker 锁 → 3 个槽【跨 phone/PC 天然共享】。
//         · 断点续跑:running 但租约过期(FC 崩)= 孤儿 → 下次 drain 自动回收重跑。
//         · 失败重试:失败回 queued 直到 maxAttempts。
//         · 取消:queued 立即 canceled;running 协作式(跑完丢弃结果)。
//         · 防重:同 code 已有活跃任务 → 复用不新建。
//   触发(均无需浏览器常驻):
//     A) 前端 fire-and-forget POST(keepalive):{ op:'enqueue', codes, nick, pw }(默认随后 drain)。
//     B) 单只/全部取消:{ op:'cancel'|'cancelAll', codes, nick, pw }。
//     C) 状态查询:{ op:'status', nick, pw }(前端也可直接靠 authStore.pull 读 batchProgress)。
//     D) 定时兜底(CRON_KEY):遍历所有账号 → 回收孤儿 + 排入过期建议 + drain,实现"每天/定时续跑"。
//
// 关键约束(承接旧版):
//   · 线上 /predict 的 36 维 OHLCV 打分【零改动】——本 handler 只是"调用方"。
//   · 只写 data.jobs/jobWorker/advice/adviceLog/batchProgress/qScore,绝不覆盖 plan/holding/closed/account。
//   · 每次 persist 都【重读云端最新账号】做保护式叠加(防止盖回用户本机刚编辑的持仓)。

import { applyCors, preflight } from './_lib.js';
import { writeAccount, readAccount, listAllAccounts, sha } from './account.js';
import { buildHoldPayload, buildWatchPayload, computePortfolio } from './_portfolio.js';
import {
  CONCURRENCY, jobsOf, enqueueJob, leaseJob, completeJob, failJob, cancelJob, cancelAll,
  reapOrphans, gcJobs, runningCount, hasPendingWork, isActive, jobsToProgress,
  acquireWorkerLock, renewWorkerLock, releaseWorkerLock, workerHeldByOther,
} from './_jobs.js';
import aiHandler from './ai.js';
import stockDetailHandler from './stock_detail.js';
import quoteHandler from './quote.js';

// 北京时间"下一交易日"友好标签(跳过周末/A股节假日),告诉军师今日买入的 T+1 最早哪天可卖。
const A_SHARE_HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]);
function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function nextTradeDayLabel() {
  const d = nowBJ(); d.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 12; i++) {
    const n = new Date(d.getTime() + i * 86400000);
    const g = n.getDay();
    if (g === 0 || g === 6) continue;
    if (A_SHARE_HOLIDAYS.has(ymd(n))) continue;
    const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][g];
    const md = `${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    return i === 1 ? `明天(${wk} ${md})` : `下一交易日${wk}(${md})`;
  }
  return '下一交易日';
}

// ---- 进程内调用另一个 handler:造最小 req/res,把 JSON 结果收集回来 ----
function invoke(handler, { method = 'GET', query = {}, body = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    const finishWith = (payload) => {
      if (done) return; done = true;
      let out = payload;
      if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* 保留字符串 */ } }
      if (out == null && chunks.length) { try { out = JSON.parse(chunks.join('')); } catch { out = chunks.join(''); } }
      resolve(out);
    };
    const res = {
      statusCode: 200, headersSent: false, _headers: {},
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return this._headers[String(k).toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      write(s) { chunks.push(typeof s === 'string' ? s : String(s)); return true; },
      send(payload) { this.headersSent = true; finishWith(payload); return this; },
      json(obj) { this.headersSent = true; finishWith(obj); return this; },
      end(payload) { this.headersSent = true; finishWith(payload != null ? payload : null); return this; },
    };
    const req = { method, query, body: body || {}, headers: {} };
    try {
      const r = handler(req, res);
      if (r && typeof r.then === 'function') r.catch(() => finishWith(null));
    } catch { finishWith(null); }
    setTimeout(() => finishWith(null), 150000);  // 兜底超时(ai.js 内部预算 115s)
  });
}

// 行情缓存(进程级,30s):并发多只时避免每只都全量拉一遍行情。
let _quoteMemo = { at: 0, key: '', map: {} };
async function fetchQuoteMap(codes) {
  const key = [...codes].sort().join(',');
  if (key && _quoteMemo.key === key && (Date.now() - _quoteMemo.at) < 30000) return _quoteMemo.map;
  const map = {};
  if (codes.length) {
    try {
      const j = await invoke(quoteHandler, { method: 'GET', query: { codes: codes.join(',') } });
      for (const it of (j && j.list) || []) if (it && it.code) map[it.code] = it;
    } catch { /* 空 map 也能跑 */ }
  }
  _quoteMemo = { at: Date.now(), key, map };
  return map;
}

// 军师历史战绩(样本<5 返回 null)
function advisorTrackFrom(data) {
  try {
    const log = (data.adviceLog || []).filter((x) => x && x.verified && x.hit != null);
    if (log.length < 5) return null;
    const win = log.filter((x) => x.hit).length;
    const avg = log.reduce((a, x) => a + (Number(x.resultPct) || 0), 0) / log.length;
    return { overallWinRate: +(win / log.length * 100).toFixed(1), overallAvgPct: +avg.toFixed(2), overallTotal: log.length };
  } catch { return null; }
}
function applyQuantScore(data, code, qs) {
  const stamp = (arr) => { for (const it of (arr || [])) if (it && it.code === code) { it.qScore = qs.qScore; it.qBias = qs.qBias; it.qAt = Date.now(); } };
  stamp(data.holding); stamp(data.plan);
}

// 生成单只:进程内并发跑 量化(stock_detail?quant=1) + 军师(ai.js) → 组装缓存项(对齐前端 saveAdvice 结构)
async function genOne({ code, name, mode, myHold, payload, quantQuery }) {
  const quantP = invoke(stockDetailHandler, { method: 'GET', query: quantQuery })
    .then((j) => (j && j.quant) ? j.quant : null).catch(() => null);
  const adviceP = invoke(aiHandler, { method: 'POST', body: { mode, payload } })
    .then((r) => (r && r.ok ? { advice: r.result, meta: r.meta, news: r.news, truncated: r.truncated } : null))
    .catch(() => null);
  const [result, adviceResp] = await Promise.all([quantP, adviceP]);

  const advice = adviceResp && adviceResp.advice;
  const meta = adviceResp && adviceResp.meta;
  const news = adviceResp && adviceResp.news;
  const truncated = !!(adviceResp && (adviceResp.truncated || (advice && advice.truncated)));
  if (!result && !advice) return null;

  const at = Date.now();
  const cacheItem = { result, advice, meta, news, truncated, at };
  let logEntry = null;
  if (advice) {
    const px = (result && result.price) || (payload && payload.holdCost) || null;
    logEntry = {
      code, name, mode,
      action: advice.action || advice.stance || '',
      tone: advice.tone,
      entryPrice: advice.buyPrice ?? advice.addPrice ?? null,
      stop: advice.stopPrice ?? null, target: advice.targetPrice ?? null,
      trust: meta && meta.trustScore ? meta.trustScore.score : null,
      resonance: meta && meta.resonance ? meta.resonance.score : null,
      priceAtAdvice: px,
      theoryNote: advice.theoryNote || '',
      at,
    };
  }
  const quantScore = (result && result.score != null && !isNaN(result.score))
    ? { qScore: Number(result.score), qBias: result.bias || '' } : null;
  return { cacheItem, logEntry, quantScore };
}

// 依据 code + 当前账号数据,构造该只的生成任务(持仓走 hold,自选走 buy)
function buildTask(data, code) {
  const holding = data.holding || [], watch = data.plan || [];
  const holdSet = new Set(holding.map((h) => h.code));
  const nameOf = (holding.find((h) => h.code === code) || watch.find((w) => w.code === code) || {}).name || code;
  return { holdSet, nameOf };
}
async function runJobGen(acc, code) {
  const data = acc.data || {};
  const holding = data.holding || [], watch = data.plan || [];
  const holdSet = new Set(holding.map((h) => h.code));
  const allCodes = [...new Set([...holding.map((h) => h.code), ...watch.map((w) => w.code)])];
  const quoteMap = await fetchQuoteMap(allCodes);
  const portfolio = computePortfolio(holding, quoteMap, data.account);
  const name = (holding.find((h) => h.code === code) || watch.find((w) => w.code === code) || {}).name || code;
  if (holdSet.has(code)) {
    const p = buildHoldPayload(holding, code, name, portfolio, data.account, data.closed, nextTradeDayLabel());
    p.advisorTrack = advisorTrackFrom(data);
    const hp = (p.holdCost != null && p.holdQty != null) ? { holdCost: String(p.holdCost), holdQty: String(p.holdQty) } : {};
    return genOne({ code, name, mode: 'hold_advice', myHold: true, payload: p, quantQuery: { code, klt: '101', lmt: '60', quant: '1', ...hp } });
  }
  const p = buildWatchPayload(code, name, portfolio, data.account);
  p.advisorTrack = advisorTrackFrom(data);
  return genOne({ code, name, mode: 'buy_advice', myHold: false, payload: p, quantQuery: { code, klt: '101', lmt: '60', quant: '1' } });
}

// ---- 任务表合并:把云端最新的【外部变更】并入内存 working(捕获其它设备新入队 / 取消)----
// drainer 拥有 lease/status 主导权 → 对它已知的 code 保留内存态;
// 对它不知道的 code(其它设备刚 enqueue 的第4只)从 fresh 补入;
// 传播外部取消:fresh 里被标记 canceled/cancelRequested 的,回灌到内存。
function mergeExternalJobs(workingData, freshData) {
  const wj = jobsOf(workingData);
  const fj = (freshData && freshData.jobs && typeof freshData.jobs === 'object') ? freshData.jobs : {};
  for (const [code, fjob] of Object.entries(fj)) {
    if (!fjob) continue;
    const cur = wj[code];
    if (!cur) { wj[code] = fjob; continue; }                       // 外部新入队 → 补入
    if (fjob.status === 'canceled') { if (isActive(cur)) cur.cancelRequested = true; if (cur.status === 'queued') { cur.status = 'canceled'; cur.finishedAt = Date.now(); } }
    else if (fjob.cancelRequested && isActive(cur)) cur.cancelRequested = true;  // 传播运行中取消意图
    // 外部对同 code 的强制重生成(新 id 且更新)→ 若内存已终态,采纳外部新任务
    else if (!isActive(cur) && (fjob.at || 0) > (cur.at || 0) && isActive(fjob)) wj[code] = fjob;
  }
}

// ---- 保护式落盘:重读云端最新账号,只叠加服务端权威字段,绝不覆盖用户 plan/holding/account ----
async function persistServer(nick, workingAcc, myId) {
  const fresh = (await readAccount(nick)) || workingAcc;
  const fdata = fresh.data || (fresh.data = {});
  const wdata = workingAcc.data || {};
  // 先把云端外部变更并入内存(其它设备新入队/取消),再整体回写 jobs(服务端权威)
  mergeExternalJobs(wdata, fdata);
  fdata.jobs = wdata.jobs;
  fdata.jobWorker = wdata.jobWorker;
  // 进度快照(旧前端仍消费 batchProgress)
  fdata.batchProgress = jobsToProgress(wdata);
  // advice 逐条时间戳并入
  const wa = (wdata.advice && typeof wdata.advice === 'object') ? wdata.advice : {};
  const fa = (fdata.advice && typeof fdata.advice === 'object') ? fdata.advice : (fdata.advice = {});
  for (const [k, v] of Object.entries(wa)) { if (!v) continue; const cur = fa[k]; if (!cur || (v.at || 0) > (cur.at || 0)) fa[k] = v; }
  // adviceLog 按 id 并集
  const wlog = wdata.adviceLog || [];
  if (wlog.length) {
    const flog = fdata.adviceLog || (fdata.adviceLog = []);
    const seen = new Set(flog.map((x) => x && x.id).filter(Boolean));
    for (const e of wlog) if (e && e.id && !seen.has(e.id)) flog.unshift(e);
    fdata.adviceLog = flog.slice(0, 500);
  }
  // qScore/qBias 写回(仅同 code 存在时)
  const stampFrom = (srcArr, dstArr) => {
    for (const s of (srcArr || [])) { if (!s || s.qScore == null) continue; for (const d of (dstArr || [])) if (d && d.code === s.code) { d.qScore = s.qScore; d.qBias = s.qBias; d.qAt = s.qAt; } }
  };
  stampFrom(wdata.holding, fdata.holding);
  stampFrom(wdata.plan, fdata.plan);
  try { await writeAccount(fresh); } catch { /* 写失败不阻断 */ }
  // 让 drainer 后续以 fresh 为工作副本:fresh 有用户最新 plan/holding + 我们刚写的服务端字段
  return fresh;
}

// ---- 并发池 drainer:单 Worker 锁下,把 queued 任务以 ≤CONCURRENCY 并发跑完 ----
// 返回 { drained(bool), ok, fail } 或 { skipped:'locked' }。
async function drainAccount(nick, initialAcc) {
  const myId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let acc = initialAcc || (await readAccount(nick));
  if (!acc) return { drained: false, ok: 0, fail: 0 };
  let data = acc.data || (acc.data = {});
  reapOrphans(data); gcJobs(data);
  if (!acquireWorkerLock(data, myId)) return { skipped: 'locked' };  // 已有他人在 drain → 交给它
  acc = await persistServer(nick, acc, myId);                          // 公布锁 + 回收结果
  data = acc.data;

  const inflight = new Map();   // code -> Promise<{code,res,err}>
  let ok = 0, fail = 0;
  try {
    while (true) {
      data = acc.data;
      reapOrphans(data); gcJobs(data);
      renewWorkerLock(data, myId);
      const free = CONCURRENCY - runningCount(data);
      const startable = Object.values(jobsOf(data))
        .filter((j) => j && j.status === 'queued' && !j.cancelRequested && !inflight.has(j.code))
        .sort((a, b) => (a.at || 0) - (b.at || 0))
        .slice(0, Math.max(0, free));
      // 处理 queued 里已被外部取消意图标记的
      for (const j of Object.values(jobsOf(data))) {
        if (j && j.status === 'queued' && j.cancelRequested) { j.status = 'canceled'; j.finishedAt = Date.now(); }
      }
      for (const j of startable) {
        leaseJob(data, j.code);
        const code = j.code;
        const p = runJobGen(acc, code)
          .then((res) => ({ code, res }))
          .catch((err) => ({ code, err }));
        inflight.set(code, p);
      }
      if (startable.length) acc = await persistServer(nick, acc, myId);   // 公布 lease

      if (inflight.size === 0) {
        if (!hasPendingWork(acc.data)) break;   // 无在跑 + 无待办 → 完成
        // 有待办却起不来(理论上 free>0 时不会发生)——保护性跳出
        break;
      }
      const done = await Promise.race(inflight.values());
      inflight.delete(done.code);
      // 应用结果到内存,再保护式落盘
      const d = acc.data;
      const job = jobsOf(d)[done.code];
      if (job && job.cancelRequested) {                       // 运行中被取消 → 丢弃结果
        job.status = 'canceled'; job.finishedAt = Date.now(); job.leaseUntil = 0;
      } else if (done.res && done.res.cacheItem) {
        (d.advice || (d.advice = {}))[done.code] = done.res.cacheItem;
        completeJob(d, done.code); ok++;
        if (done.res.logEntry) {
          const log = d.adviceLog || (d.adviceLog = []);
          const dup = log.find((x) => x.code === done.code && (Date.now() - (x.at || 0)) < 600000);
          if (!dup) { log.unshift({ id: `${done.res.logEntry.at}_${done.code}`, verified: false, hit: null, resultPct: null, ...done.res.logEntry }); d.adviceLog = log.slice(0, 500); }
        }
        if (done.res.quantScore) applyQuantScore(d, done.code, done.res.quantScore);
      } else {
        failJob(d, done.code, done.err ? String(done.err.message || done.err) : '生成失败(军师+量化均空)');
        if (jobsOf(d)[done.code] && jobsOf(d)[done.code].status === 'failed') fail++;
      }
      acc = await persistServer(nick, acc, myId);
    }
  } finally {
    // 释放锁(重读最新账号再放,避免盖回)
    const fresh = (await readAccount(nick)) || acc;
    const fdata = fresh.data || (fresh.data = {});
    if (!workerHeldByOther(fdata, myId)) {
      releaseWorkerLock(fdata, myId);
      // 合并我们内存里的最终 jobs 状态
      mergeExternalJobs(acc.data, fdata);
      fdata.jobs = acc.data.jobs;
      fdata.batchProgress = jobsToProgress(acc.data);
      try { await writeAccount(fresh); } catch { /* ignore */ }
    }
  }
  return { drained: true, ok, fail };
}

// 排入某账号的"过期/缺建议"任务(定时兜底 & 全量刷新用)。scope 过滤 hold/watch/all。
const GAP_MS = 6 * 3600 * 1000;
function enqueueStale(data, { scope = 'all', force = false } = {}) {
  const holding = data.holding || [], watch = data.plan || [];
  const advice = (data.advice && typeof data.advice === 'object') ? data.advice : {};
  const holdSet = new Set(holding.map((h) => h.code));
  const isFresh = (code) => { if (force) return false; const a = advice[code]; return !!(a && a.at && (Date.now() - a.at) < GAP_MS); };
  let n = 0;
  const add = (code, name, mode) => { const { created } = enqueueJob(data, { code, name, mode, source: 'cron', force }); if (created) n++; };
  if (scope === 'all' || scope === 'hold') {
    for (const code of [...new Set(holding.map((h) => h.code))]) {
      if (isFresh(code)) continue;
      const name = (holding.find((h) => h.code === code) || {}).name || code;
      add(code, name, 'hold_advice');
    }
  }
  if (scope === 'all' || scope === 'watch') {
    for (const code of [...new Set(watch.map((w) => w.code))].filter((c) => !holdSet.has(c))) {
      if (isFresh(code)) continue;
      const name = (watch.find((w) => w.code === code) || {}).name || code;
      add(code, name, 'buy_advice');
    }
  }
  return n;
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const scope = ['all', 'hold', 'watch'].includes(body.scope) ? body.scope : 'all';
  const force = body.force != null ? !!body.force : true;   // 用户主动生成默认强制重生成

  // ====== 分支 A:账号密码鉴权的按需操作(enqueue / cancel / cancelAll / status / drain)======
  const isUser = !!(body.nick && body.pw != null);
  if (isUser) {
    const nick = String(body.nick || '').trim();
    const pw = String(body.pw || '');
    if (!nick || !pw) return res.end(JSON.stringify({ ok: false, error: '缺少账号或密码' }));
    const acc = await readAccount(nick);
    if (!acc) return res.end(JSON.stringify({ ok: false, error: '账号不存在' }));
    if (acc.pwHash !== sha(pw)) return res.end(JSON.stringify({ ok: false, error: '密码错误' }));
    const data = acc.data || (acc.data = {});
    const op = body.op || 'enqueue';
    const started = Date.now();

    try {
      if (op === 'status') {
        return res.end(JSON.stringify({ ok: true, jobs: jobsOf(data), progress: jobsToProgress(data), concurrency: CONCURRENCY, running: runningCount(data) }));
      }
      if (op === 'cancel') {
        const codes = Array.isArray(body.codes) ? body.codes.filter(Boolean).map(String) : [];
        let n = 0; for (const c of codes) if (cancelJob(data, c)) n++;
        await persistServer(nick, acc, 'cancel');
        return res.end(JSON.stringify({ ok: true, canceled: n, progress: jobsToProgress(data) }));
      }
      if (op === 'cancelAll') {
        const n = cancelAll(data);
        await persistServer(nick, acc, 'cancelAll');
        return res.end(JSON.stringify({ ok: true, canceled: n, progress: jobsToProgress(data) }));
      }
      // enqueue(默认):把 codes 排入队列(防重),随后 drain(拿不到锁则由在跑的 drainer 接手)
      const codes = Array.isArray(body.codes) ? [...new Set(body.codes.filter(Boolean).map(String))] : [];
      if (!codes.length) return res.end(JSON.stringify({ ok: false, error: '缺少 codes' }));
      const holding = data.holding || [], watch = data.plan || [];
      const holdSet = new Set(holding.map((h) => h.code));
      const nameOf = (c) => (holding.find((h) => h.code === c) || watch.find((w) => w.code === c) || {}).name || c;
      let enq = 0, dup = 0;
      for (const code of codes) {
        if (scope === 'hold' && !holdSet.has(code)) continue;
        if (scope === 'watch' && holdSet.has(code)) continue;
        const mode = holdSet.has(code) ? 'hold_advice' : 'buy_advice';
        const { created } = enqueueJob(data, { code, name: nameOf(code), mode, source: 'ondemand', force });
        created ? enq++ : dup++;
      }
      await persistServer(nick, acc, 'enqueue');   // 立刻公布队列(另一设备可见)
      // 尝试成为 drainer;拿不到锁说明已有 drainer 在跑,会自动捞起我们刚入队的
      const dr = await drainAccount(nick, await readAccount(nick));
      return res.end(JSON.stringify({
        ok: true, enqueued: enq, dedup: dup,
        drained: dr && dr.drained ? true : false, ok2: dr && dr.ok, fail: dr && dr.fail,
        concurrency: CONCURRENCY, elapsedMs: Date.now() - started,
      }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
    }
  }

  // ====== 分支 B:定时兜底(CRON_KEY)——回收孤儿 + 排入过期建议 + drain 所有账号 ======
  const CRON_KEY = process.env.CRON_KEY;
  if (CRON_KEY) {
    const given = req.headers['x-cron-key'] || (req.query && req.query.key) || (req.body && req.body.key);
    if (given !== CRON_KEY) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  }
  const onlyNick = body.nick ? String(body.nick) : null;
  const started = Date.now();
  try {
    let accounts = await listAllAccounts();
    if (onlyNick) accounts = accounts.filter((a) => a.nick === onlyNick);
    const summary = [];
    let totalOk = 0, totalFail = 0;
    for (const acc0 of accounts) {
      const nick = acc0.nick;
      try {
        const acc = await readAccount(nick);
        if (!acc) continue;
        const data = acc.data || (acc.data = {});
        reapOrphans(data);
        // 定时:排入过期建议(force=false → 6h 新鲜度节流,不烧 token);同时续跑遗留 queued/孤儿
        const enq = enqueueStale(data, { scope, force: body.force === true });
        await persistServer(nick, acc, 'cron');
        const dr = hasPendingWork(acc.data) ? await drainAccount(nick, await readAccount(nick)) : { drained: false, ok: 0, fail: 0 };
        totalOk += dr.ok || 0; totalFail += dr.fail || 0;
        summary.push({ nick, enqueued: enq, ...(dr.skipped ? { skipped: dr.skipped } : { ok: dr.ok, fail: dr.fail }) });
      } catch (e) { summary.push({ nick, error: String(e.message || e) }); }
    }
    return res.end(JSON.stringify({ ok: true, scope, accounts: accounts.length, ok2: totalOk, fail: totalFail, elapsedMs: Date.now() - started, summary }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
  }
}
