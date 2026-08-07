// ============ 云端定时生成「AI 操作建议」(server-side,脱离浏览器) ============
// 背景/为什么存在:
//   原先 AI 操作建议的【自动刷新】与【生成】全在浏览器里跑(App.jsx setInterval → adviceRunner
//   → callAIStream)。用户一关浏览器,定时器和在途生成全没了 → "退出浏览器就停了"。
//   本 handler 把这条链路搬到服务端:由云端调度器(Mira 定时任务 / 外部 cron)按时 POST 命中,
//   遍历所有账号 → 复刻前端 buildHoldSpec/buildWatchSpec 口径构造 payload → 【进程内】调用
//   已有的 ai.js(军师建议) 与 stock_detail.js(量化打分) handler(完整复用其大盘/资金/量化增强)
//   → 把结果按【逐条时间戳】合并回该账号 data.advice(+ 决策记录 data.adviceLog)→ 写回 OSS。
//   这样即便用户没开任何浏览器,建议也在云端每日/定时刷新;下次任意设备登录/轮询即可看到。
//
// 关键约束:
//   · 线上 /predict 的 36 维 OHLCV 打分【零改动】——本 handler 只是"调用方",不碰量化模型口径。
//   · 只写 data.advice / data.adviceLog,绝不动用户的 plan/holding/closed/account(避免覆盖用户编辑)。
//   · 串行处理、逐只 await(对齐前端 adviceBatch CONCURRENCY=1),避免打爆 LLM 网关配额。
//   · 幂等 + 新鲜度节流:GAP_MS 内已有新鲜建议的 code 跳过,不重复烧 token。
//   · 鉴权:需带 X-Cron-Key(= 环境变量 CRON_KEY)或 ?key=,防止被匿名 HTTP 触发器滥用。
//
// 触发方式(二选一,均无需浏览器):
//   A) Mira 定时任务(推荐,现成基础设施):每天盘前/收盘后 curl 本地址。
//   B) 外部 cron/云监控定时拨测 POST 本地址。
// 请求:POST /api/cron_advice   body: { scope?: 'all'|'hold'|'watch', force?: bool, nick?: '仅跑某账号' }
//   header: X-Cron-Key: <CRON_KEY>

import { applyCors, preflight } from './_lib.js';
import { listAllAccounts, writeAccount, readAccount, sha } from './account.js';
import { buildHoldPayload, buildWatchPayload, computePortfolio } from './_portfolio.js';
import aiHandler from './ai.js';
import stockDetailHandler from './stock_detail.js';
import quoteHandler from './quote.js';

const GAP_MS = 6 * 3600 * 1000; // 6h 内已有新鲜建议 → 跳过(与前端 adviceDaily.isFresh 同口径)

// 北京时间"下一交易日"友好标签(与前端 review.nextTradingDayLabel 同口径,跳过周末/A股节假日)。
// 用于告诉军师:今日买入的 T+1 锁定手数最早哪天可卖。
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

// ---- 进程内调用另一个 handler:造一个最小 req/res,把 JSON 结果收集回来 ----
// ai.js 非流式(stream 不传)会走 res.status(200).send(JSON字符串);stock_detail/quote 走 sendJson。
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
      statusCode: 200,
      headersSent: false,
      _headers: {},
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
    // 兜底:极端情况下 handler 既不 send 也不抛 → 超时保护(ai.js 内部预算 115s)
    setTimeout(() => finishWith(null), 150000);
  });
}

// 取一组 code 的实时/最近行情(供算账户浮盈/仓位;休市则 price 兜底昨收)
async function fetchQuoteMap(codes) {
  const map = {};
  if (!codes.length) return map;
  try {
    const j = await invoke(quoteHandler, { method: 'GET', query: { codes: codes.join(',') } });
    for (const it of (j && j.list) || []) if (it && it.code) map[it.code] = it;
  } catch { /* 空 map 也能跑,建议里价格由 stock_detail/quant 兜底 */ }
  return map;
}

// 生成单只建议:进程内并发跑 量化(stock_detail?quant=1) + 军师(ai.js) → 组装成与前端 saveAdvice 同结构的缓存项
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
  const cacheItem = { result, advice, meta, news, truncated, at }; // 对齐 adviceCache.saveAdvice 落盘结构(含 at)
  // 决策记录(对齐 adviceRunner → planStore.logAdvice 的字段),供事后回测胜率
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

// 处理单个账号:构造持仓/自选建议任务 → 串行生成 → 合并进 acc.data → 返回是否有改动
//   opts.codes:仅生成这些 code(用户按需勾选的批量生成),缺省=全部(定时任务遍历)。
//   opts.onTick(progress):每完成一只回调一次,供【按需分支】把进度增量写回云端(两端可轮询看到)。
async function processAccount(acc, { scope, force, codes = null, onTick = null } = {}) {
  const data = acc.data || (acc.data = {});
  const holding = data.holding || [];
  const watch = data.plan || [];
  if (!holding.length && !watch.length) return { changed: false, ok: 0, skip: 0, fail: 0 };

  const advice = (data.advice && typeof data.advice === 'object') ? data.advice : (data.advice = {});
  const isFresh = (code) => {
    if (force) return false;
    const a = advice[code];
    return !!(a && a.at && (Date.now() - a.at) < GAP_MS);
  };
  const codeSet = (codes && codes.length) ? new Set(codes) : null; // 指定则只跑这些

  const holdSet = new Set(holding.map((h) => h.code));
  const allCodes = [...new Set([...holding.map((h) => h.code), ...watch.map((w) => w.code)])];
  const quoteMap = await fetchQuoteMap(allCodes);
  const portfolio = computePortfolio(holding, quoteMap, data.account);
  const nameOf = (code) =>
    (holding.find((h) => h.code === code) || watch.find((w) => w.code === code) || {}).name || code;

  // 组装任务列表(scope 过滤 + codes 过滤 + 新鲜度节流;按需分支 codeSet 命中即算已选)
  const tasks = [];
  if (scope === 'all' || scope === 'hold') {
    for (const code of [...new Set(holding.map((h) => h.code))]) {
      if (codeSet && !codeSet.has(code)) continue;
      if (isFresh(code)) continue;
      const name = nameOf(code);
      const p = buildHoldPayload(holding, code, name, portfolio, data.account, data.closed, nextTradeDayLabel());
      const hp = (p.holdCost != null && p.holdQty != null) ? { holdCost: String(p.holdCost), holdQty: String(p.holdQty) } : {};
      p.advisorTrack = advisorTrackFrom(data);
      tasks.push({ code, name, mode: 'hold_advice', myHold: true, payload: p,
        quantQuery: { code, klt: '101', lmt: '60', quant: '1', ...hp } });
    }
  }
  if (scope === 'all' || scope === 'watch') {
    for (const code of [...new Set(watch.map((w) => w.code))].filter((c) => !holdSet.has(c))) {
      if (codeSet && !codeSet.has(code)) continue;
      if (isFresh(code)) continue;
      const name = nameOf(code);
      const p = buildWatchPayload(code, name, portfolio, data.account);
      p.advisorTrack = advisorTrackFrom(data);
      tasks.push({ code, name, mode: 'buy_advice', myHold: false, payload: p,
        quantQuery: { code, klt: '101', lmt: '60', quant: '1' } });
    }
  }

  let ok = 0, fail = 0, changed = false;
  const skip = (codeSet ? codeSet.size : allCodes.length) - tasks.length;
  // 进度对象(与前端 adviceBatch.getBatchState 同结构,便于前端直接消费):
  //   running/total/done/ok/fail/skipped/items([{code,name,status}])/startedAt/finishedAt/at
  const total = tasks.length;
  const items = tasks.map((t) => ({ code: t.code, name: t.name, status: 'pending' }));
  const startTick = Date.now();
  const progress = () => ({
    running: true, total, done: ok + fail, ok, fail, skipped: skip < 0 ? 0 : skip,
    current: [], items: items.map((x) => ({ ...x })),
    startedAt: startTick, finishedAt: 0, at: Date.now(), source: 'server',
  });
  const setItem = (code, status) => { const it = items.find((x) => x.code === code); if (it) it.status = status; };
  // 串行:一次一只,完整生成完再下一只(对齐前端 CONCURRENCY=1)
  for (const t of tasks) {
    setItem(t.code, 'running');
    if (onTick) { try { await onTick({ ...progress(), current: [t.code] }); } catch { /* ignore */ } }
    try {
      const r = await genOne(t);
      if (r && r.cacheItem) {
        advice[t.code] = r.cacheItem; changed = true; ok++;
        setItem(t.code, 'ok');
        if (r.logEntry) {
          const log = data.adviceLog || (data.adviceLog = []);
          const dup = log.find((x) => x.code === t.code && x.mode === t.mode && (Date.now() - (x.at || 0)) < 600000);
          if (!dup) { log.unshift({ id: `${r.logEntry.at}_${t.code}`, verified: false, hit: null, resultPct: null, ...r.logEntry }); data.adviceLog = log.slice(0, 500); }
        }
        // 量化得分写回自选/持仓卡专用字段(排序/展示同源)——写进 plan/holding 的 qScore/qBias(非结构性字段,安全)
        if (r.quantScore) applyQuantScore(data, t.code, r.quantScore);
      } else { fail++; setItem(t.code, 'fail'); }
    } catch { fail++; setItem(t.code, 'fail'); }
    if (onTick) { try { await onTick(progress()); } catch { /* ignore */ } }
  }
  // 收尾进度(finished)
  const finalProgress = { ...progress(), running: false, finishedAt: Date.now() };
  return { changed, ok, skip: skip < 0 ? 0 : skip, fail, finalProgress };
}

// 军师历史战绩(真实回测胜率)→ 从账号 adviceLog 现算,口径尽量对齐前端 planStore.adviceStats 的核心字段。
// 保守起见:样本<5 返回 null(与前端一致),避免早期噪声误导军师自我校准。
function advisorTrackFrom(data) {
  try {
    const log = (data.adviceLog || []).filter((x) => x && x.verified && x.hit != null);
    if (log.length < 5) return null;
    const win = log.filter((x) => x.hit).length;
    const avg = log.reduce((a, x) => a + (Number(x.resultPct) || 0), 0) / log.length;
    return { overallWinRate: +(win / log.length * 100).toFixed(1), overallAvgPct: +avg.toFixed(2), overallTotal: log.length };
  } catch { return null; }
}

// 量化得分写回(qScore/qBias 是卡片展示/排序用的附加字段,不改变持仓结构)
function applyQuantScore(data, code, qs) {
  const stamp = (arr) => { for (const it of (arr || [])) if (it && it.code === code) { it.qScore = qs.qScore; it.qBias = qs.qBias; it.qAt = Date.now(); } };
  stamp(data.holding); stamp(data.plan);
}

// 把本轮生成的结果【保护式合并】进云端最新版账号并写回。
//   在【按需分支】的每只完成后调用:先重读云端最新账号(拿到浏览器可能刚改过的 holding/plan/account),
//   只把「服务端生成」的部分(batchProgress + 本轮 advice/adviceLog/qScore)叠加上去再写,
//   绝不用内存里的旧 holding/account 覆盖用户正在本机编辑的持仓——实现「服务端生成、两端都看到进度」
//   且不误伤用户编辑。progress=进度快照(与前端 adviceBatch 同结构)。
async function persistProgress(nick, workingAcc, progress) {
  const fresh = (await readAccount(nick)) || workingAcc;
  const fdata = fresh.data || (fresh.data = {});
  // 1) batchProgress:服务端权威,直接覆盖
  fdata.batchProgress = progress;
  // 2) advice:把本轮已生成的逐条按时间戳并入(不丢云端其它更新的)
  const wa = (workingAcc.data && workingAcc.data.advice) || {};
  const fa = (fdata.advice && typeof fdata.advice === 'object') ? fdata.advice : (fdata.advice = {});
  for (const [k, v] of Object.entries(wa)) {
    if (!v) continue;
    const cur = fa[k];
    if (!cur || (v.at || 0) > (cur.at || 0)) fa[k] = v;
  }
  // 3) adviceLog:按 id 并集
  const wlog = (workingAcc.data && workingAcc.data.adviceLog) || [];
  if (wlog.length) {
    const flog = fdata.adviceLog || (fdata.adviceLog = []);
    const seen = new Set(flog.map((x) => x && x.id).filter(Boolean));
    for (const e of wlog) if (e && e.id && !seen.has(e.id)) flog.unshift(e);
    fdata.adviceLog = flog.slice(0, 500);
  }
  // 4) qScore/qBias 写回(仅同 code 存在时)
  const stampFrom = (srcArr, dstArr) => {
    for (const s of (srcArr || [])) {
      if (!s || s.qScore == null) continue;
      for (const d of (dstArr || [])) if (d && d.code === s.code) { d.qScore = s.qScore; d.qBias = s.qBias; d.qAt = s.qAt; }
    }
  };
  stampFrom(workingAcc.data && workingAcc.data.holding, fdata.holding);
  stampFrom(workingAcc.data && workingAcc.data.plan, fdata.plan);
  try { await writeAccount(fresh); } catch { /* 写失败不阻断后续生成 */ }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const scope = ['all', 'hold', 'watch'].includes(body.scope) ? body.scope : 'all';
  const force = !!body.force;

  // ====== 分支 A:【按需批量生成】(前端一键触发,账号密码鉴权) ======
  // 用户在手机/电脑点「一次性生成」→ fire-and-forget POST 本地址,服务端在 FC(600s)里跑完,
  // 每完成一只就把进度(batchProgress)+建议增量写回云端;两端(手机/电脑)靠 authStore.pull
  // 轮询同一份云端进度,实现「手机生成、电脑同步看到批量生成进程」;且脱离浏览器,退到后台也跑得完。
  const isOnDemand = !!(body.ondemand || (Array.isArray(body.codes) && body.codes.length) || (body.nick && body.pw != null));
  if (isOnDemand) {
    const nick = String(body.nick || '').trim();
    const pw = body.pw != null ? String(body.pw) : '';
    const codes = Array.isArray(body.codes) ? [...new Set(body.codes.filter(Boolean).map(String))] : null;
    if (!nick || !pw) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: '缺少账号或密码' })); }
    const acc = await readAccount(nick);
    if (!acc) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: '账号不存在' })); }
    if (acc.pwHash !== sha(pw)) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: '密码错误' })); }

    const started = Date.now();
    try {
      const onTick = async (progress) => { await persistProgress(nick, acc, progress); };
      // force 默认置真:用户主动点生成,勾选哪些就重生成哪些(与前端 adviceBatch 一致,不做新鲜度节流)
      const r = await processAccount(acc, { scope, force: body.force != null ? force : true, codes, onTick });
      // 收尾:再写一次最终进度(running:false)
      if (r.finalProgress) { try { await persistProgress(nick, acc, r.finalProgress); } catch { /* ignore */ } }
      return res.end(JSON.stringify({
        ok: true, ondemand: true, nick,
        total: r.finalProgress ? r.finalProgress.total : (r.ok + r.fail),
        ok: r.ok, fail: r.fail, skip: r.skip, elapsedMs: Date.now() - started,
      }));
    } catch (e) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
    }
  }

  // ====== 分支 B:【定时全量刷新】(调度器触发,CRON_KEY 鉴权) ======
  // 鉴权:防止匿名 HTTP 触发器被滥用烧 token。未配置 CRON_KEY 时(本地/未设)放行。
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
    let totalOk = 0, totalFail = 0, totalSkip = 0;
    // 账号间也串行,进一步平滑对 LLM 网关的压力
    for (const acc of accounts) {
      let r;
      try { r = await processAccount(acc, { scope, force }); }
      catch (e) { r = { changed: false, ok: 0, skip: 0, fail: 0, error: String(e.message || e) }; }
      if (r.changed) { try { await writeAccount(acc); } catch (e) { r.writeError = String(e.message || e); } }
      totalOk += r.ok || 0; totalFail += r.fail || 0; totalSkip += r.skip || 0;
      summary.push({ nick: acc.nick, ok: r.ok, skip: r.skip, fail: r.fail, changed: r.changed, ...(r.error ? { error: r.error } : {}), ...(r.writeError ? { writeError: r.writeError } : {}) });
    }
    return res.end(JSON.stringify({
      ok: true, scope, force,
      accounts: accounts.length, ok: totalOk, fail: totalFail, skip: totalSkip,
      elapsedMs: Date.now() - started, summary,
    }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
  }
}
