// AI 分析代理：服务端调用 LLM，Key 从环境变量读取，绝不暴露给前端
// POST body: { mode: 'market'|'sector'|'stock'|'scan', payload: {...} }
import { buildCorpus, retrieve } from './_rag.js';
import { techSummaryForAI, fetchQuantPredict, backtestSignal } from './_ta.js';
import { marketTimePromptBlock, marketTimeContext } from './_market_time.js';
import { getLatestDailySummary } from './_daily_summary.js';
import { fetchNews, fetchClsTelegraph } from './_market_data.js';
import { callChat, callChatWithRetry, parseLLMJson } from './_llm.js';
import { ensureConfig, currentConfig, getModel } from './_llm_config.js';
import { applyCors, preflight } from './_lib.js';
import { SYSTEM_PROMPT, ADVISOR_SYSTEM, buildUserPrompt, isAdvisorMode, maxTokensForMode } from './_ai_prompts.js';

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) { if (arr.length < 2) return 0; const m = avg(arr); return Math.sqrt(avg(arr.map((x) => (x - m) ** 2))); }

// ============ 个股历史规律画像（做T策略自适应的核心）============
// 输入：近约60日日线 candles（含 open/close/high/low/pct/volume/preClose 或可推）
// 输出：这只股“自己的性格”，用于让 AI 自动选激进/均衡/稳健 + 正T/反T
function computeStockProfile(candles) {
  const cs = (candles || []).filter((c) => c && c.high != null && c.low != null && c.close != null);
  if (cs.length < 10) return null;
  const n = cs.length;
  // 昨收序列（优先用上一根收盘）
  const prevCloseOf = (i) => (i > 0 ? cs[i - 1].close : (cs[i].open || cs[i].close));

  // 1) 日内振幅：每日 (high-low)/prevClose
  const amps = cs.map((c, i) => { const pc = prevCloseOf(i); return pc ? ((c.high - c.low) / pc) * 100 : 0; });
  const avgAmp = +avg(amps).toFixed(2);
  const recentAmp = +avg(amps.slice(-10)).toFixed(2);

  // 2) 波动性：日涨跌幅标准差（性格烈度）
  const pcts = cs.map((c, i) => { if (c.pct != null) return c.pct; const pc = prevCloseOf(i); return pc ? ((c.close - pc) / pc) * 100 : 0; });
  const vol = +std(pcts).toFixed(2);

  // 3) 均值回归 vs 趋势延续：大涨(>+3%)/大跌(<-3%)次日方向
  let bigUp = 0, bigUpRev = 0, bigDn = 0, bigDnRev = 0;
  for (let i = 0; i < n - 1; i++) {
    const today = pcts[i], next = pcts[i + 1];
    if (today > 3) { bigUp++; if (next < 0) bigUpRev++; }
    if (today < -3) { bigDn++; if (next > 0) bigDnRev++; }
  }
  const upRevRate = bigUp ? +(bigUpRev / bigUp).toFixed(2) : null;   // 大涨后回落概率
  const dnRevRate = bigDn ? +(bigDnRev / bigDn).toFixed(2) : null;   // 大跌后反弹概率
  // 回归倾向评分：两者都高=强均值回归（适合高抛低吸做T）
  const revScore = (upRevRate != null && dnRevRate != null) ? +(((upRevRate + dnRevRate) / 2)).toFixed(2) : null;

  // 4) 开盘路径规律：低开走高 / 高开走低 频次（决定正T还是反T更契合这只股）
  let openHighClose = 0, openLowClose = 0, validOpen = 0;
  for (let i = 0; i < n; i++) {
    const pc = prevCloseOf(i); if (!pc || cs[i].open == null) continue; validOpen++;
    const openGap = (cs[i].open - pc) / pc;      // 高开/低开
    const dayMove = (cs[i].close - cs[i].open);  // 日内从开到收
    if (openGap < -0.005 && dayMove > 0) openLowClose++;  // 低开走高 → 利好正T低吸
    if (openGap > 0.005 && dayMove < 0) openHighClose++;  // 高开走低 → 利好反T高抛
  }
  const lowOpenUpRate = validOpen ? +(openLowClose / validOpen).toFixed(2) : null;
  const highOpenDownRate = validOpen ? +(openHighClose / validOpen).toFixed(2) : null;

  // 5) 量价配合：放量日（量>近20日均量1.5倍）里上涨占比
  const vols = cs.map((c) => c.volume || 0);
  const ma20vol = avg(vols.slice(-20));
  let bigVol = 0, bigVolUp = 0;
  for (let i = Math.max(0, n - 20); i < n; i++) { if (ma20vol && vols[i] > ma20vol * 1.5) { bigVol++; if (pcts[i] > 0) bigVolUp++; } }
  const volPriceSync = bigVol ? +(bigVolUp / bigVol).toFixed(2) : null;

  // 6) 近期结构：连阳/连阴、20/60日区间位置
  let streak = 0; for (let i = n - 1; i >= 0; i--) { if (streak === 0) streak = pcts[i] > 0 ? 1 : (pcts[i] < 0 ? -1 : 0); else if ((streak > 0 && pcts[i] > 0) || (streak < 0 && pcts[i] < 0)) streak += streak > 0 ? 1 : -1; else break; }
  const last = cs[n - 1].close;
  const win = (k) => cs.slice(-k);
  const hi = (k) => Math.max(...win(k).map((c) => c.high));
  const lo = (k) => Math.min(...win(k).map((c) => c.low));
  const posIn = (k) => { const H = hi(k), L = lo(k); return H > L ? +(((last - L) / (H - L)) * 100).toFixed(0) : null; };

  // 综合判定：策略性格 + 方向偏好（供 AI 参考，AI 仍可结合当日盘面覆盖）
  let styleSuggest = 'balanced';
  if (vol >= 4 || recentAmp >= 6) styleSuggest = 'aggressive';      // 大波动/大振幅 → 激进博差价
  else if (vol <= 2 && recentAmp <= 3) styleSuggest = 'conservative'; // 温吞 → 稳健小做
  const tradable = recentAmp >= 2.5;  // 振幅太小做T没肉

  let dirBias = 'balanced', dirReason = '';
  if (revScore != null && revScore >= 0.55) { dirBias = 'meanReversion'; dirReason = '强均值回归：大涨常回落、大跌常反弹，正T反T都适合，看当日位置决定先买还是先卖'; }
  // 开盘路径偏好：只有当两者“明显不对称”时才定向，避免因A股普遍低开走高而系统性偏正T
  const loRate = lowOpenUpRate || 0, hoRate = highOpenDownRate || 0;
  if (loRate >= 0.3 && loRate - hoRate >= 0.1) { dirBias = 'positive'; dirReason = `低开走高(${(loRate * 100).toFixed(0)}%)明显多于高开走低(${(hoRate * 100).toFixed(0)}%)，略偏正T低吸`; }
  else if (hoRate >= 0.3 && hoRate - loRate >= 0.1) { dirBias = 'reverse'; dirReason = `高开走低(${(hoRate * 100).toFixed(0)}%)明显多于低开走高(${(loRate * 100).toFixed(0)}%)，略偏反T高抛`; }
  else if (dirBias !== 'meanReversion') { dirBias = 'balanced'; dirReason = '开盘路径无明显偏向，正T/反T均可，以当日分时位置为准'; }

  return {
    days: n,
    avgAmplitude: avgAmp, recentAmplitude: recentAmp,   // 平均/近10日日内振幅%
    volatility: vol,                                    // 日涨跌幅标准差（性格烈度）
    bigUpRevRate: upRevRate, bigDnRevRate: dnRevRate, meanRevScore: revScore, // 均值回归性
    lowOpenUpRate, highOpenDownRate,                    // 开盘路径规律
    volPriceSync,                                       // 放量上涨配合度
    streak,                                             // 当前连阳(+)/连阴(-)根数
    posIn20: posIn(20), posIn60: posIn(Math.min(60, n)),
    styleSuggest, tradable, dirBias, dirReason,
  };
}

// 抓取当日分时（时间,价格,量,均价VWAP），多镜像容错
function toSecid(code) { const c = String(code).trim(); return /^(6|9|5)/.test(c) ? '1.' + c : '0.' + c; }
async function fetchTrend(code) {
  const hosts = ['https://push2his.eastmoney.com', 'https://82.push2his.eastmoney.com'];
  const path = `/api/qt/stock/trends2/get?secid=${toSecid(code)}&fields1=f1,f2&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
  for (const h of hosts) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(h + path, { signal: ctrl.signal, headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      const j = await r.json();
      const trends = j && j.data && j.data.trends;
      if (trends && trends.length) {
        return trends.map((line) => {
          const p = line.split(',');
          return { time: p[0].slice(11), price: Number(p[1]), vol: Number(p[2]), avg: Number(p[3]) };
        });
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// 个股资金面：主力/超大单/大单 净额 + 5日主力均值 + 盘口委比委差
// 关键：用【历史每日资金流】接口(fflow/daykline)，收盘后/开盘前依然能回溯到最近交易日，不会归零；
// 实时快照(stock/get f62)只在盘中有效、清算后清零，故仅用于取盘口委比与"当日实时"补充。
async function fetchStockFund(code) {
  const secid = toSecid(code);
  const yi = (v) => (v == null || v === '-' || v === '' || isNaN(Number(v)) ? null : +(Number(v) / 1e8).toFixed(2));
  const pct = (v) => (v == null || v === '-' || v === '' || isNaN(Number(v)) ? null : +Number(v).toFixed(2));
  let daily = null;

  // 1) 历史每日资金流（可回溯）。只取最近8天(lmt=8)避免全历史大响应超时；多镜像竞速(Promise.any)
  // fields2: f51日期,f52主力净额,f53小单,f54中单,f55大单,f56超大单,f57主力净占比%
  const hisHosts = ['https://push2his.eastmoney.com', 'https://82.push2his.eastmoney.com', 'https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
  const hpath = `/api/qt/stock/fflow/daykline/get?lmt=8&klt=101&secid=${secid}&ut=b2884a393a59ad64002292a3e90d46a5&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const tryHis = (h) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    return fetch(h + hpath, { signal: ctrl.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } })
      .then((r) => r.json())
      .then((j) => { const kl = j && j.data && j.data.klines; if (kl && kl.length) return kl; throw new Error('empty'); })
      .finally(() => clearTimeout(t));
  };
  try {
    const kl = await Promise.any(hisHosts.map(tryHis));
    const rows = kl.map((line) => { const p = line.split(','); return { date: p[0], main: Number(p[1]), small: Number(p[2]), mid: Number(p[3]), big: Number(p[4]), super: Number(p[5]), mainPct: Number(p[6]) }; });
    const last = rows[rows.length - 1];
    const last5 = rows.slice(-5);
    const sum5 = last5.reduce((a, x) => a + (x.main || 0), 0);
    daily = {
      date: last.date,
      mainNetYi: yi(last.main), mainNetPct: pct(last.mainPct),
      superNetYi: yi(last.super), bigNetYi: yi(last.big), midNetYi: yi(last.mid), smallNetYi: yi(last.small),
      main5dYi: yi(sum5), main5dAvgYi: yi(sum5 / (last5.length || 1)),
      trend5: last5.map((x) => yi(x.main)),   // 近5日主力净额序列(亿)
      inflowDays: last5.filter((x) => x.main > 0).length, // 近5日流入天数
    };
  } catch { /* 所有镜像失败 → 走备用源 */ }

  // 1b) 备用：若竞速全失败，串行再给最稳的镜像一次独立、更长超时的机会(大盘股响应慢，竞速易被别的镜像拖累)
  if (!daily) {
    for (const h of ['https://push2his.eastmoney.com', 'https://push2.eastmoney.com']) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 9000);
        const r = await fetch(h + hpath, { signal: ctrl.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(t);
        const j = await r.json();
        const kl = j && j.data && j.data.klines;
        if (kl && kl.length) {
          const rows = kl.map((line) => { const p = line.split(','); return { date: p[0], main: Number(p[1]), small: Number(p[2]), mid: Number(p[3]), big: Number(p[4]), super: Number(p[5]), mainPct: Number(p[6]) }; });
          const last = rows[rows.length - 1]; const last5 = rows.slice(-5);
          const sum5 = last5.reduce((a, x) => a + (x.main || 0), 0);
          daily = { date: last.date, mainNetYi: yi(last.main), mainNetPct: pct(last.mainPct), superNetYi: yi(last.super), bigNetYi: yi(last.big), midNetYi: yi(last.mid), smallNetYi: yi(last.small), main5dYi: yi(sum5), main5dAvgYi: yi(sum5 / (last5.length || 1)), trend5: last5.map((x) => yi(x.main)), inflowDays: last5.filter((x) => x.main > 0).length };
          break;
        }
      } catch { /* try next */ }
    }
  }

  // 2) 实时快照：取盘口委比/委差(盘中有效) + 当日实时主力净额(盘中非0则优先)
  let snap = null;
  const rtHosts = ['https://push2.eastmoney.com', 'https://82.push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
  const rpath = `/api/qt/stock/get?secid=${secid}&fields=f62,f184,f66,f72,f164,f191,f192`;
  const tryRt = (h) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    return fetch(h + rpath, { signal: ctrl.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } })
      .then((r) => r.json())
      .then((j) => { if (j && j.data) return j.data; throw new Error('empty'); })
      .finally(() => clearTimeout(t));
  };
  try {
    const d = await Promise.any(rtHosts.map(tryRt));
    snap = { mainNetYi: yi(d.f62), mainNetPct: pct(d.f184), superNetYi: yi(d.f66), bigNetYi: yi(d.f72), main5dYi: yi(d.f164), weibi: pct(d.f191), weicha: (d.f192 == null || d.f192 === '-') ? null : Math.round(Number(d.f192)) };
  } catch { /* ignore */ }

  if (!daily && !snap) return null;
  const base = daily || {};
  // 当日主力净额：盘中用实时快照(非0)，否则用历史最近交易日
  const realtimeMain = snap && snap.mainNetYi != null && snap.mainNetYi !== 0 ? snap.mainNetYi : null;
  // 主力资金【连续性】：从最近交易日往回数,当前连续净流入(正)/连续净流出(负)天数。
  // 口径与 K 线连阳连阴的 streak 一致:同号累加,遇反号或 0 即断。用户关心"主力是否连续做多/做空",
  // 一天数字不算数,连续几天才见真章 —— 显式算好给军师,免得它自己从 trend5 里数错。
  const mainStreak = (() => {
    const seq = base.trend5;
    if (!Array.isArray(seq) || !seq.length) return null;
    let s = 0;
    for (let i = seq.length - 1; i >= 0; i--) {
      const v = seq[i];
      if (v == null) break;
      if (s === 0) { s = v > 0 ? 1 : (v < 0 ? -1 : 0); if (s === 0) break; }
      else if ((s > 0 && v > 0) || (s < 0 && v < 0)) s += s > 0 ? 1 : -1;
      else break;
    }
    return s;
  })();
  return {
    asOfDate: base.date || null,               // 资金数据对应的交易日
    isHistorical: !realtimeMain,               // true=用的是最近收盘数据(非实时)
    mainNetYi: realtimeMain != null ? realtimeMain : (base.mainNetYi ?? null),
    mainNetPct: (snap && snap.mainNetPct) ?? base.mainNetPct ?? null,
    superNetYi: (realtimeMain != null && snap && snap.superNetYi) ? snap.superNetYi : (base.superNetYi ?? null),
    bigNetYi: (realtimeMain != null && snap && snap.bigNetYi) ? snap.bigNetYi : (base.bigNetYi ?? null),
    midNetYi: base.midNetYi ?? null, smallNetYi: base.smallNetYi ?? null,
    main5dYi: base.main5dYi ?? (snap && snap.main5dYi) ?? null,
    main5dAvgYi: base.main5dAvgYi ?? null,
    trend5: base.trend5 || null,
    inflowDays: base.inflowDays ?? null,
    mainStreak,                                 // 当前连续净流入(+)/净流出(-)天数;null=数据不足
    weibi: snap ? snap.weibi : null, weicha: snap ? snap.weicha : null,  // 盘口仅盘中有效
  };
}


// 个股近期龙虎榜 + 买方席位识别（是否知名游资/机构专用席位 = 聪明钱）
const HOT_SEATS = ['章盟主', '赵老哥', '炒股养家', '作手新一', '方新侠', '孙哥', 'UBS', '摩根', '中金', '华鑫', '东方财富', '拉萨', '成都', '深股通', '沪股通', '机构专用', '国泰君安', '中信', '量化'];
async function fetchStockLHB(code) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const flt = encodeURIComponent(`(SECURITY_CODE="${code}")`);
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=SECURITY_CODE,TRADE_DATE,EXPLANATION,BILLBOARD_NET_AMT,CHANGE_RATE&filter=${flt}&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=5&source=WEB&client=WEB`;
    const r = await fetch(url, { signal: ctrl.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    const j = await r.json();
    const rows = (j && j.result && j.result.data) || [];
    if (!rows.length) return null;
    const recent = rows[0];
    const lhbDate = String(recent.TRADE_DATE || '').slice(0, 10);
    let seats = [];
    try {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 6000);
      const flt2 = encodeURIComponent(`(SECURITY_CODE="${code}")(TRADE_DATE='${lhbDate}')`);
      const url2 = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_DAILYDETAILSBUY&columns=OPERATEDEPT_NAME,BUY,NET&filter=${flt2}&sortColumns=NET&sortTypes=-1&pageSize=5&source=WEB&client=WEB`;
      const r2 = await fetch(url2, { signal: ctrl2.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t2);
      const j2 = await r2.json();
      seats = ((j2 && j2.result && j2.result.data) || []).map((s) => s.OPERATEDEPT_NAME).filter(Boolean);
    } catch { /* ignore */ }
    const smart = seats.filter((nm) => HOT_SEATS.some((h) => nm.includes(h)));
    return {
      onList: true, date: lhbDate, times30d: rows.length,
      reason: recent.EXPLANATION || '',
      netAmount: recent.BILLBOARD_NET_AMT != null ? Number(recent.BILLBOARD_NET_AMT) : null, // 龙虎榜净买额(元),供 eventSignal 判方向
      buySeats: seats.slice(0, 5),
      smartMoney: smart.length > 0,
      smartSeats: smart.slice(0, 3),
    };
  } catch { return null; }
}

// 宏观/国内外重大事件新闻（当日财经要闻）——让军师把大环境纳入分析，而非只看个股技术
// 用东财财经要闻搜索(全球宏观/政策/市场关键词)，取当日最新几条标题
async function fetchMacroNews() {
  try {
    const kw = '宏观 政策 央行 美股 关税 A股 市场';
    const param = encodeURIComponent(JSON.stringify({
      uid: '', keyword: kw, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: 10 } },
    }));
    const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${param}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { Referer: 'https://so.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    const txt = await r.text();
    const clean = txt.replace(/^x\(/, '').replace(/\);?$/, '');
    const nj = JSON.parse(clean);
    const arr = (nj.result && nj.result.cmsArticleWebOld) || [];
    const heads = arr.map((a) => ({ title: (a.title || '').replace(/<[^>]+>/g, ''), date: a.date || '', url: a.url || '' }))
      .filter((x) => x.title).slice(0, 8);
    return heads.length ? heads : null;
  } catch { return null; }
}

// 行业/板块新闻——个股不仅要看宏观与自身消息，还要看所属行业的风向
// 用该股所属行业名做定向检索(东财资讯)，取当日最新几条标题
async function fetchIndustryNews(industry) {
  if (!industry) return null;
  try {
    const kw = `${industry} 行业`;
    const heads = await fetchNews(kw, 5);
    return (heads && heads.length) ? heads : null;
  } catch { return null; }
}

// 权威财经快讯(财联社系/金十/东财聚合)——供 AI 各流程复用为"外部实时消息面"
// 与 fetchMacroNews(深度稿件) 互补:快讯更新鲜、更贴近盘面异动
async function fetchMacroFlashes(size = 8) {
  try {
    const arr = await fetchClsTelegraph(size);
    return (arr && arr.length) ? arr.map((n) => (n.src ? `[${n.src}]${n.title}` : n.title)).slice(0, size) : null;
  } catch { return null; }
}


export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  // 注意：Content-Type 延后设置——流式走 SSE、非流式走 JSON，见下方 streaming 分支

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const BASE = process.env.LLM_BASE_URL;
  const KEY = process.env.LLM_API_KEY;
  // 运行时配置优先（前端「AI 模型配置」写入 OSS）：先预热同步缓存，再取 BASE/KEY/模型
  await ensureConfig();
  const cfg = currentConfig();
  const RT_BASE = cfg.baseUrl || BASE;
  const RT_KEY = cfg.apiKey || KEY;
  const MODEL = getModel('chat');
  // 顶级操盘军师专用模型：深度个股研判(做T/加减仓/买入/复盘)用更强、更快、原生JSON稳定的模型
  const ADVISOR_MODEL = getModel('advisor');
  if (!RT_BASE || !RT_KEY) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ ok: false, error: 'LLM 未配置' }));
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const mode = (body && body.mode) || 'market';
    const payload = (body && body.payload) || {};
    const streaming = !!(body && body.stream); // 客户端可选开启 SSE 进度流

    // SSE 进度流：数据采集阶段(查大盘/资金/分时/龙虎榜/量化…)对用户是"黑盒卡住"，
    // 开启后把每个采集里程碑实时推给前端(查大盘✓ 查资金✓ 量化打分✓ 生成建议中…)，
    // 最后再推一个 result 事件带完整结构化结果。非流式调用保持原样(整段 JSON)，向后兼容。
    if (streaming) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    // 统一出口：流式用 SSE 事件，非流式回退为一次性 JSON
    const emit = (event, data) => { if (streaming) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 断连 */ } } };
    const finish = (obj) => {
      if (streaming) { emit('result', obj); return res.end(); }
      return res.status(200).send(JSON.stringify(obj));
    };
    // 采集里程碑进度事件
    const phase = (text, key) => emit('phase', { text, key });

    // ===== 全局时间预算：Vercel maxDuration=60s，留足余量在 57s 内必须返回 JSON =====
    // 数据采集阶段(补大盘/资金/分时/量化…)可能耗时 15~20s，之后 LLM 生成又要时间；
    // 不设总预算时两段相加可能超 60s 被平台强杀、返回非 JSON。这里统一编排。
    const START = Date.now();
    const BUDGET = 115000;
    const remain = () => BUDGET - (Date.now() - START);

    // stock 模式：接入 RAG（近5日走势+主营+联网新闻）
    let ragText = '';
    let newsRefs = [];
    if (mode === 'stock' && payload.code) {
      try {
        const corpus = await buildCorpus(payload.code);
        const hits = await retrieve(
          `${corpus.name} 短线 资金 走势 消息面 基本面`,
          corpus.docs,
          7
        );
        ragText = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n');
        newsRefs = (corpus.news || []).filter((n) => n.url).slice(0, 5);
      } catch (e) {
        // RAG 失败不阻断主分析
      }
    }

    // t_advice / plan / price / hold_advice / buy_advice / review 模式：服务端补齐"大盘情绪+资金流向+个股历史走势+分时+量化"，让建议有据可依
    if ((mode === 't_advice' || mode === 'plan' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') && payload.code) {
      try {
        phase('正在采集大盘 / 资金 / 分时 / 龙虎榜 / 量化数据…', 'collect');
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = `${proto}://${host}`;
        const getJ = (p) => {
          // 内部 API 调用加超时保护(原来无超时——某个内部接口卡住会拖垮整个数据采集、烧光预算)
          const c = new AbortController();
          const to = setTimeout(() => c.abort(), 8000);
          return fetch(origin + p, { signal: c.signal }).then((r) => r.json()).catch(() => null).finally(() => clearTimeout(to));
        };

        const [mkt, sec, detail, trend, stockFund, lhb, corpus, macroNews, todayQ, dailySummary, macroFlashes] = await Promise.all([
          getJ('/api/market'),
          getJ('/api/sectors?type=industry&sort=main'),
          getJ(`/api/stock_detail?code=${payload.code}&klt=101&lmt=60`),
          fetchTrend(payload.code),
          fetchStockFund(payload.code),
          fetchStockLHB(payload.code),
          buildCorpus(payload.code).catch(() => null),  // 消息面/公告/基本面 RAG 语料
          fetchMacroNews(),                              // 国内外宏观/重大事件
          getJ(`/api/quote?codes=${payload.code}&_t=${Date.now()}`),  // ★今日实时行情(涨跌幅/涨停/量比)——纠正"技术面/资金是昨日口径"的滞后
          getLatestDailySummary().catch(() => null),     // ★今日策略日报摘要——作为"外部市场环境"注入(阶段2)
          fetchMacroFlashes(8).catch(() => null),        // ★权威财经快讯(财联社系/金十)——外部实时消息面
        ]);
        // ★外部市场环境：把当天策略日报摘要注入，让个股建议结合大盘/板块/海外环境判断
        if (dailySummary && dailySummary.text) payload.dailyReport = dailySummary;
        // ★今日实时行情：这是"当下事实"，优先级高于昨日收盘的 tech/资金
        {
          const q0 = todayQ && todayQ.list && todayQ.list[0];
          if (q0 && q0.price != null) {
            // ★时效闸门:盘前(<9:15)/盘后/休市 时 /api/quote 返回的是【上一交易日收盘快照】,
            //   绝不能当"今日实时行情"。用 marketTimeContext().isLive 判定:
            //   isLive=true(集合竞价/盘中/午间/午盘) → 真·实时行情,可算今日合法价带;
            //   isLive=false(盘前未开盘/盘后/休市) → 昨日收盘口径,不算"今日"涨跌停价(否则会错一天)。
            const mtc = marketTimeContext();
            const isLive = !!mtc.isLive;
            // ★涨停/跌停价:按【昨收×(1±涨跌幅限制)】四舍五入到分。限制比例按板块/ST判定:
            //   创业板(300/301)、科创板(688) = ±20%; ST/*ST(名称含ST) = ±5%; 其余主板 = ±10%。
            //   北交所(8/4开头)=±30%。仅盘中(isLive)才注入"今日合法价带",盘前/盘后不注入避免口径错位。
            const nm = String((payload.name || (q0 && q0.name) || '')).toUpperCase();
            const codeStr = String(payload.code || '');
            const isST = nm.includes('ST');
            let ratio = 0.10;
            if (isST) ratio = 0.05;
            else if (/^(30|68)/.test(codeStr)) ratio = 0.20;
            else if (/^(8|4)/.test(codeStr)) ratio = 0.30;
            const base = q0.prevClose;
            // 只有实时(盘中)才给 LLM 硬性"今日合法价带";非实时时置 null,提示词自动转收盘口径。
            const limitUpPrice = (isLive && base != null) ? +(base * (1 + ratio)).toFixed(2) : null;
            const limitDownPrice = (isLive && base != null) ? +(base * (1 - ratio)).toFixed(2) : null;
            payload.todayQuote = {
              live: isLive,                     // ★是否今日实时(false=上一交易日收盘快照)
              asOfLabel: mtc.dataDayLabel,      // 该行情实际对应的交易日
              phase: mtc.phase,                 // 盘前/盘中/盘后/休市
              price: q0.price, pct: q0.pct,
              // 涨停/跌停标记仅实时时有意义;盘前的 isLimit* 是昨日的,不代表今日
              isLimitUp: isLive && !!q0.isLimitUp, isLimitDown: isLive && !!q0.isLimitDown,
              limitUpPrice, limitDownPrice, limitRatioPct: +(ratio * 100).toFixed(0),
              high: q0.high, low: q0.low, open: q0.open, prevClose: q0.prevClose,
              turnover: q0.turnover, volRatio: q0.volRatio,
              bigMove: isLive && q0.pct != null && Math.abs(q0.pct) >= 7,  // 今日大涨/大跌(>7%),仅实时口径
            };
          }
        }
        if (macroNews && macroNews.length) payload.macroNews = macroNews.map((n) => n.title).slice(0, 6);
        if (macroFlashes && macroFlashes.length) payload.macroFlashes = macroFlashes.slice(0, 8);
        phase('行情 / 资金 / 消息面已就位，正在量化打分…', 'quant');
        // 消息面：直接取新闻/公告/基本面文档(不做向量检索，省3~5s，避免函数超时)
        if (corpus && corpus.docs && corpus.docs.length) {
          payload.newsDigest = corpus.docs
            .filter((d) => d.type === 'news' || d.type === 'profile' || d.type === 'summary')
            .map((d) => d.text).slice(0, 6);
          if (corpus.news && corpus.news.length) {
            payload.newsHeadlines = corpus.news.slice(0, 6).map((n) => n.title).filter(Boolean);
            newsRefs = corpus.news.filter((n) => n.url).slice(0, 5);  // 供前端引用消息来源
          }
        }
        // ★行业新闻 + 量化预测：二者相互独立，并行取(原来串行，白白多花一次网络往返)。
        //   行业新闻依赖 corpus.profile.industry；量化预测依赖 detail.candles，均已在上面 Promise.all 就绪。
        const industry = corpus && corpus.profile && corpus.profile.industry;
        const hasCandles = detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length >= 25;
        // ★让量化模型"基于现在预测未来":盘中把实时价/量并入送模型的最后一根K线。
        //   stock_detail 的日K末根盘中虽是"进行中"的今日bar,但其收盘价可能滞后于 /api/quote 的最新价;
        //   盘前/盘后/休市则末根为昨日收盘,不应改动(此时预测本就是"基于上一交易日")。
        //   仅当 isLive 且实时价有效时,用实时 price/high/low 覆盖今日末根,使36因子基于当下重算。
        let quantCandles = hasCandles ? detail.candles : null;
        let quantRealtime = null;
        if (hasCandles && payload.todayQuote && payload.todayQuote.live && payload.todayQuote.price != null) {
          const tq = payload.todayQuote;
          const cs0 = detail.candles;
          const lastBar = cs0[cs0.length - 1];
          const merged = { ...lastBar,
            close: tq.price,
            high: Math.max(lastBar.high != null ? lastBar.high : tq.price, tq.high != null ? tq.high : tq.price, tq.price),
            low: Math.min(lastBar.low != null ? lastBar.low : tq.price, tq.low != null ? tq.low : tq.price, tq.price),
            open: tq.open != null ? tq.open : lastBar.open,
          };
          quantCandles = [...cs0.slice(0, -1), merged];
          quantRealtime = {
            price: tq.price, pct: tq.pct, turnover: tq.turnover, volRatio: tq.volRatio,
            asOf: tq.asOfLabel || null, live: true, phase: tq.phase || null,
            marketVolLevel: (mkt && mkt.ok && mkt.breadth) ? mkt.breadth.volLevel : null,
          };
        }
        const [indNews, quant] = await Promise.all([
          industry
            ? fetchIndustryNews(industry).catch(() => null)
            : Promise.resolve(null),
          hasCandles
            ? fetchQuantPredict(payload.code, quantCandles, (payload.holdCost ? { cost: payload.holdCost, qty: payload.holdQty } : null), 7000, quantRealtime).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (industry && indNews && indNews.length) {
          payload.industry = industry;
          payload.industryNews = indNews.map((n) => n.title).filter(Boolean).slice(0, 5);
        }
        if (lhb) payload.lhb = lhb;
        // 信号回测：用历史K线检验该股"金叉后上涨"的命中率，给预测一个可信度自评(纯计算,无网络)
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length >= 40) {
          try { const bt = backtestSignal(detail.candles, 5); if (bt) payload.backtest = bt; } catch { /* ignore */ }
        }
        // 量化预测已在上面与行业新闻并行取到(quant)——此处不再重复请求。

        // 大盘情绪
        if (mkt && mkt.ok) {
          const b = mkt.breadth || {};
          payload.market = {
            indices: (mkt.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
            up: b.up, down: b.down, limitUp: b.limitUp, limitDown: b.limitDown,
            upDownRatio: b.down ? +(b.up / b.down).toFixed(2) : null,
            amountYi: b.amountYi,        // ★两市实时成交额(亿元)
            volVsAvg5: b.volVsAvg5,      // ★较近5日均量的偏离%
            volLevel: b.volLevel,        // ★放量/平量/缩量
          };
        }
        // ★事件确认高把握层(P2:正交高精度筛子)。优先用【离线权威标记】——qlib-service 每日
        //   拉 Tushare limit_list_d/top_list,按高纯度规则(连板≥2 / 涨停封单强 / 龙虎榜净买>0)逐票判定,
        //   holdout 样本外精度 89%~98%,与信号头【并列】给军师。拿不到权威标记时(首日/服务未热更)
        //   回落到基于K线的粗估(pct≥9.8 数连板),保证向后兼容、绝不阻断。
        {
          const ev = {};
          const authTag = (quant && quant.ok && quant.eventTag) ? quant.eventTag : null;
          if (authTag && authTag.confirmed) {
            // 权威口径:真实 Tushare 连板数/封单强度/龙虎榜净买 + 历史精度参考
            ev.source = 'offline';
            if (authTag.streak >= 2) ev.limitStreak = authTag.streak;
            if (authTag.streak >= 1) ev.limitUpToday = true;
            ev.fdStrong = !!authTag.fdStrong;
            if (authTag.lhbNetYi != null) {
              ev.lhbNetYi = authTag.lhbNetYi;
              ev.lhbNetDir = authTag.lhbNetYi > 0 ? '净买入' : authTag.lhbNetYi < 0 ? '净卖出' : '持平';
            }
            ev.reasons = authTag.reasons || [];
            ev.precisionRef = authTag.precisionRef ?? null;
            ev.tradeDate = authTag.tradeDate ?? null;
            ev.highConf = `事件确认命中${ev.reasons.length ? '(' + ev.reasons.join('、') + ')' : ''}` +
              `${ev.precisionRef != null ? `·历史样本外精度约${ev.precisionRef}%` : ''}`;
          } else {
            // 回落:基于已取到的 todayQuote(涨停)与 lhb(龙虎榜)的粗估(无真实连板/封单强度)
            ev.source = 'estimate';
            const tq = payload.todayQuote;
            if (tq && tq.live && tq.isLimitUp) {
              ev.limitUpToday = true;
              const cs = (detail && detail.ok && detail.candles) || [];
              let streak = 0;
              for (let i = cs.length - 1; i >= 0; i--) {
                if (cs[i] && cs[i].pct != null && cs[i].pct >= 9.8) streak++;
                else break;
              }
              ev.limitStreak = streak + 1;  // 含今日
            }
            if (lhb && (lhb.netAmount != null || lhb.net != null)) {
              const net = lhb.netAmount != null ? lhb.netAmount : lhb.net;
              ev.lhbNetYi = +(net / 1e8).toFixed(2);
              ev.lhbNetDir = net > 0 ? '净买入' : net < 0 ? '净卖出' : '持平';
            }
            if (ev.limitStreak >= 2) ev.highConf = `连板≥2梯队(历史样本外次日上涨命中率约87.5%)`;
          }
          if (Object.keys(ev).length > 1 || ev.highConf) {
            payload.eventSignal = ev;
          }
        }
        // 大盘资金流向（板块前3流入/后3流出 + 全市场净额）
        if (sec && sec.ok && Array.isArray(sec.list)) {
          const sorted = [...sec.list].sort((a, b2) => b2.mainInflow - a.mainInflow);
          const yi = (v) => +(v / 1e8).toFixed(1);
          const net = sec.list.reduce((a, s) => a + s.mainInflow, 0);
          payload.marketFlow = {
            netYi: yi(net),
            topInflow: sorted.slice(0, 3).map((s) => ({ name: s.name, inflowYi: yi(s.mainInflow) })),
            topOutflow: sorted.slice(-3).map((s) => ({ name: s.name, inflowYi: yi(s.mainInflow) })),
          };
        }
        // 个股近20日走势（简化：近20日涨跌幅序列 + 均线位置 + 阶段高低）
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length) {
          const cs = detail.candles;
          const closes = cs.map((c) => c.close);
          const last = closes[closes.length - 1];
          const ma5 = avg(closes.slice(-5)), ma10 = avg(closes.slice(-10)), ma20 = avg(closes.slice(-20));
          const hi20 = Math.max(...cs.slice(-20).map((c) => c.high));
          const lo20 = Math.min(...cs.slice(-20).map((c) => c.low));
          payload.history = {
            last5Pct: cs.slice(-5).map((c) => +c.pct.toFixed(2)),
            ma5: +ma5.toFixed(2), ma10: +ma10.toFixed(2), ma20: +ma20.toFixed(2),
            vsMa5: last >= ma5 ? '站上5日线' : '跌破5日线',
            vsMa20: last >= ma20 ? '在20日线上方(中期偏多)' : '在20日线下方(中期偏弱)',
            high20: +hi20.toFixed(2), low20: +lo20.toFixed(2),
            posInRange: hi20 > lo20 ? +(((last - lo20) / (hi20 - lo20)) * 100).toFixed(0) : null, // 现价在20日区间的位置%
          };
          // 个股历史规律画像（近60日）——做T/建仓/减仓/持仓建议/复盘自动选价的核心依据
          if (mode === 't_advice' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') {
            const prof = computeStockProfile(cs);
            if (prof) payload.stockProfile = prof;
          }
          // 专业技术指标摘要（ATR/布林/RSI/KDJ/MACD + 买卖价位锚）——所有定价场景都引用
          if (detail.tech) {
            const t = techSummaryForAI(detail.tech);
            if (t) payload.tech = t;
          }
        }
        // 量化模型打分（CloudBase 微服务，多因子融合）——配置了才有，作为更专业的一层参考
        if (quant && quant.ok) {
          payload.quant = {
            score: quant.score, bias: quant.bias, tDir: quant.tDir,
            forecast: quant.forecast,   // {upProb,expRet,targetLow/Mid/High,direction,confidence}
            hitProb: quant.hitProb,     // LGB达标概率(0~1,原始分辨力,未做isotonic校准)
            reads: quant.reads, asOf: quant.asOf,
          };
          // ★高把握买点信号头(isotonic校准 + gate≥85%闸门):只有 fired=true 才是"校准后高可信"信号。
          //   连同买入/止盈/止损价一并透传给军师,支撑其"把握闸+赔率闸"双闸门判断(P0"少出手"纪律)。
          const hcs = quant.highConfSignal;
          if (hcs && typeof hcs === 'object') {
            payload.quant.highConfSignal = {
              fired: !!hcs.fired,
              credibility: hcs.credibility ?? null,             // 校准后可信度%
              gate: hcs.gate != null ? Math.round(hcs.gate * 100) : null,
              buyPrice: hcs.buyPrice ?? null,
              takeProfit: hcs.takeProfit ?? null,
              stopLoss: hcs.stopLoss ?? null,
              label: hcs.label ?? null,
            };
          }
        }
        // 当日分时结构（VWAP均价、日内高低、当前节奏、现价相对均价/高低的位置）
        if (trend && trend.length) {
          const prices = trend.map((t) => t.price)
          const now = prices[prices.length - 1]
          const vwap = trend[trend.length - 1].avg // 东财分时自带均价即VWAP
          const dHi = Math.max(...prices), dLo = Math.min(...prices)
          // 节奏：比较最近30分钟与前段
          const seg = Math.min(30, Math.floor(prices.length / 3))
          const recent = prices.slice(-seg)
          const earlier = prices.slice(-seg * 2, -seg)
          const rAvg = avg(recent), eAvg = earlier.length ? avg(earlier) : rAvg
          let rhythm = '横盘震荡'
          if (rAvg > eAvg * 1.006) rhythm = '尾段拉升'
          else if (rAvg < eAvg * 0.994) rhythm = '尾段跳水/回落'
          // 分时形态
          const nearLow = now <= dLo * 1.005
          const nearHigh = now >= dHi * 0.995
          payload.intraday = {
            now: +now.toFixed(2), vwap: +vwap.toFixed(2),
            dayHigh: +dHi.toFixed(2), dayLow: +dLo.toFixed(2),
            vsVwap: now >= vwap ? '现价在均价线上方(日内偏强)' : '现价在均价线下方(日内偏弱)',
            posInDay: dHi > dLo ? +(((now - dLo) / (dHi - dLo)) * 100).toFixed(0) : 50, // 现价在当日区间位置%
            rhythm,
            atDayLow: nearLow, atDayHigh: nearHigh,
          }
        }
        // 个股资金面（主力/超大单/大单净额 + 5日主力 + 盘口委比委差）
        if (stockFund) payload.stockFund = stockFund;
        // 交易时段标记：非交易时段时，分时/盘口为最后收盘数据，模型据此参考"收盘后"口径
        {
          const nb = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
          const wd = nb.getUTCDay(), hm = nb.getUTCHours() * 60 + nb.getUTCMinutes();
          const trading = wd >= 1 && wd <= 5 && ((hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900));
          payload.marketPhase = trading ? '盘中(实时数据)' : '非交易时段(以下分时/盘口/资金为最近收盘数据，请按收盘后口径分析，为下一交易时段做准备)';
        }
        // 大盘环境自适应：只影响【仓位/择时】，不再一票否决【个股方向/择股】(择时与择股分离)
        if (payload.market) {
          const m = payload.market;
          let envScore = 50; // 0~100，越低越弱
          if (m.upDownRatio != null) envScore += Math.min(25, Math.max(-25, (m.upDownRatio - 1) * 25));
          if (m.limitUp != null && m.limitDown != null) envScore += Math.min(15, Math.max(-15, (m.limitUp - m.limitDown * 3) / 5));
          const idxAvg = (m.indices || []).length ? avg(m.indices.map((i) => i.pct || 0)) : 0;
          envScore += Math.min(20, Math.max(-20, idxAvg * 8));
          envScore = Math.round(Math.min(100, Math.max(0, envScore)));
          let envLevel = '中性', suggestPosition = '常规(3~5成)', weak = false;
          if (envScore <= 30) { envLevel = '极弱(冰点)'; suggestPosition = '轻仓(≤2成)'; weak = true; }
          else if (envScore <= 44) { envLevel = '偏弱'; suggestPosition = '控仓(2~3成)'; weak = true; }
          else if (envScore >= 68) { envLevel = '强势'; suggestPosition = '可积极(5~7成)'; }
          payload.marketEnv = {
            score: envScore, level: envLevel, weak, suggestPosition,
            // 客观规律：弱市压【仓位】而非禁【看多】；逆势强票仍可小仓做多，弱票才回避
            note: weak
              ? `大盘${envLevel}：这是【择时】信号，只压仓位不否决个股——总仓位建议${suggestPosition}、单笔试仓、严设止损；但若个股是逆势强票(抗跌/资金逆流入/创新高)，仍可小仓做多，不要因大盘弱就把好票也一律观望。弱票、破位票才回避。`
              : (envLevel === '强势' ? `大盘强势：可顺势积极，仓位${suggestPosition}，仍守纪律。` : `大盘中性：常规操作，仓位${suggestPosition}，跟随个股信号。`),
          };
        }
        // 逆势强票识别(D)：个股相对大盘的强弱——大盘跌它抗跌/资金逆势流入/创近期新高
        {
          const idxAvg = payload.market && (payload.market.indices || []).length ? avg(payload.market.indices.map((i) => i.pct || 0)) : 0;
          // 个股当日涨跌幅：优先今日实时行情，否则用最近日K的 pct
          let stkPct = null;
          if (payload.todayQuote && payload.todayQuote.pct != null) stkPct = payload.todayQuote.pct;
          else if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length) {
            const lc = detail.candles[detail.candles.length - 1];
            if (lc && lc.pct != null) stkPct = lc.pct;
          }
          const sf = payload.stockFund;
          const flags = [];
          // 抗跌/强于大盘：大盘跌但个股跌得少或翻红
          if (stkPct != null && idxAvg < -0.3 && stkPct > idxAvg + 0.5) flags.push('强于大盘(抗跌/逆势翻红)');
          // 资金逆势流入：大盘弱但主力近5日净流入
          if (sf && sf.main5dYi != null && sf.main5dYi > 0 && idxAvg < 0) flags.push('资金逆势净流入');
          // 技术创新高/多头：多头排列 + 站上20日线
          const t2 = payload.tech;
          if (t2 && String(t2.maTrend).includes('多头')) flags.push('均线多头(强势结构)');
          if (t2 && t2.boll && t2.boll.pctB != null && t2.boll.pctB >= 80) flags.push('逼近布林上轨(强势)');
          if (flags.length >= 2) payload.counterTrend = { isStrong: true, flags, note: `逆势强票信号:[${flags.join('、')}]。弱市中这类是资金抱团方向，应优先给"小仓做多"而非观望。` };
          else if (flags.length === 1) payload.counterTrend = { isStrong: false, flags, note: `部分强势:[${flags.join('、')}]` };
        }
        // 信号共振计分（0~6）：技术金叉多头 / 主力真流入 / 量化看涨 / 消息面无雷 / 逆势强票 / 龙虎榜聪明钱
        {
          let score = 0; const hit = [];
          const t2 = payload.tech;
          if (t2 && (String(t2.maCross).includes('金叉') || String(t2.maTrend).includes('多头') || (t2.bull != null && t2.bear != null && t2.bull - t2.bear >= 2))) { score++; hit.push('技术偏多(金叉/多头)'); }
          const sf = payload.stockFund;
          if (sf && ((sf.mainNetYi != null && sf.mainNetYi > 0) || (sf.main5dYi != null && sf.main5dYi > 0))) { score++; hit.push('主力资金净流入'); }
          const q2 = payload.quant && payload.quant.forecast;
          if (q2 && ((q2.upProb != null && q2.upProb >= 52) || String(q2.direction).includes('涨'))) { score++; hit.push('量化看涨'); }
          // 消息面无雷（无减持/问询/立案/解禁等负面词）
          const negWords = ['减持', '问询', '立案', '违规', '解禁', '亏损', '预亏', '诉讼', '质押', 'ST', '退市'];
          const newsBlob = [...(payload.newsHeadlines || []), ...(payload.newsDigest || [])].join(' ');
          const hasNeg = negWords.some((w) => newsBlob.includes(w));
          if (newsBlob && !hasNeg) { score++; hit.push('消息面暂无明显利空'); }
          else if (hasNeg) { hit.push('⚠消息面有潜在利空'); }
          // 逆势强票加分(D)：不再因大盘弱扣分，改为个股强则加分
          if (payload.counterTrend && payload.counterTrend.isStrong) { score++; hit.push('逆势强票(抗跌/资金逆流入)'); }
          else if (payload.marketEnv && !payload.marketEnv.weak) { score++; hit.push('大盘不逆风'); }
          if (payload.lhb && payload.lhb.smartMoney) { score = Math.min(6, score + 1); hit.push('龙虎榜有知名游资/机构'); }
          payload.resonance = { score: Math.min(6, score), max: 6, hits: hit, hasNegNews: hasNeg };
        }
        // 综合可信度(0~100)：共振(45%) + 信号回测(20%) + 大盘环境(15%) + 消息面(10%) + 军师历史真实胜率(10%)
        {
          const rez = payload.resonance ? payload.resonance.score / (payload.resonance.max || 6) : 0.4;
          const bt = payload.backtest && payload.backtest.hitRate != null ? payload.backtest.hitRate / 100 : 0.5;
          const env = payload.marketEnv ? payload.marketEnv.score / 100 : 0.5;
          const news = (payload.resonance && payload.resonance.hasNegNews) ? 0.2 : 0.9;
          // 军师历史真实胜率：优先本类胜率，否则综合胜率；样本不足则中性0.5
          const at = payload.advisorTrack;
          const trackWr = at ? (at.modeWinRate != null && at.modeTotal >= 5 ? at.modeWinRate : at.overallWinRate) : null;
          const track = trackWr != null ? Math.max(0, Math.min(1, trackWr / 100)) : 0.5;
          let conf = Math.round((rez * 0.45 + bt * 0.20 + env * 0.15 + news * 0.10 + track * 0.10) * 100);
          // 历史胜率过低(<40%)时进一步压制信心上限，避免"越错越自信"
          if (trackWr != null && trackWr < 40) conf = Math.min(conf, 55);
          conf = Math.min(95, Math.max(15, conf)); // 永远不给100%,也不低于15
          let band = conf >= 68 ? '较可信' : conf >= 48 ? '中等' : '低(仅参考)';
          payload.trustScore = { score: conf, band, note: '综合共振/信号回测/大盘环境/消息面/军师历史真实胜率得出，非胜率承诺' };
        }
        // 风格
        payload.style = payload.style || 'balanced'
      } catch (e) {
        // 补数据失败不阻断
      }
    }

    const isAdvisor = isAdvisorMode(mode);
    const useModel = isAdvisor ? ADVISOR_MODEL : MODEL;
    const sysPrompt = isAdvisor ? ADVISOR_SYSTEM : SYSTEM_PROMPT;

    // 已采集到的数据 meta——即便 LLM 超时降级，也把这些"确定性数据"回传前端展示(有价值、不空手)
    const collectedMeta = {
      resonance: payload.resonance || null,
      counterTrend: payload.counterTrend || null,
      trustScore: payload.trustScore || null,
      marketEnv: payload.marketEnv || null,
      backtest: payload.backtest || null,
      lhb: payload.lhb ? { onList: true, date: payload.lhb.date, times30d: payload.lhb.times30d, smartMoney: payload.lhb.smartMoney, smartSeats: payload.lhb.smartSeats, buySeats: payload.lhb.buySeats } : null,
      hasNegNews: payload.resonance ? payload.resonance.hasNegNews : null,
      newsHeadlines: payload.newsHeadlines || null,
      macroNews: payload.macroNews || null,
      fundAsOf: payload.stockFund ? { date: payload.stockFund.asOfDate, historical: payload.stockFund.isHistorical, main5dAvg: payload.stockFund.main5dAvgYi, inflowDays: payload.stockFund.inflowDays, mainStreak: payload.stockFund.mainStreak ?? null } : null,
      marketPhase: payload.marketPhase || null,
      todayQuote: payload.todayQuote || null,
      dailyReport: payload.dailyReport ? { sessionCn: payload.dailyReport.sessionCn, day: payload.dailyReport.day } : null,
    };
    // 数据采集后剩余时间不足 → 直接降级返回(不硬闯 LLM 被平台强杀)。带 meta 让前端仍能展示已查到的确定性数据。
    if (remain() < 9000) {
      return finish({
        ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
        error: '数据采集用时较长，本次分析未能在限定时间内完成，请稍后重试。',
        meta: collectedMeta, news: newsRefs,
      });
    }

    phase('数据齐全，正在生成操作建议…', 'llm');
    // LLM 超时按【剩余预算】动态给：预留 2.5s 兜底返回时间，最少给 8s。
    // 军师模式(t_advice/hold_advice/buy_advice/review/price/plan)走 DeepSeek-V4-Pro，实测常需 47s+；
    // FC 超时已放到 600s，代码预算 115s，故 LLM 上限也整体放大：军师 100s、常规 80s，交由 remain() 收敛。
    const llmCap = isAdvisor ? 100000 : 80000;
    const llmTimeout = Math.max(8000, Math.min(llmCap, remain() - 2500));

    const { resp, done } = await callChatWithRetry({
      model: useModel,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'system', content: marketTimePromptBlock() },
        { role: 'user', content: buildUserPrompt(mode, payload, ragText) },
      ],
      temperature: 0.2,   // JSON 结构化输出：低温提升稳定性与可解析率，减少字段漂移
      maxTokens: maxTokensForMode(mode),
      timeoutMs: llmTimeout,
      responseFormat: { type: 'json_object' },
    }, { budgetLeftMs: () => remain() - 2500 });  // 上游抖动/5xx 且预算足够时快速重试一次；abort/网络错误不抛出 → 转入降级返回
    done();

    // LLM 超时/网络错误 → 结构化降级返回(带已采集 meta)，前端可提示"重试/缩小范围"而非"服务不可用"
    if (resp && resp.__err) {
      const timedOut = resp.__err.name === 'AbortError';
      return finish({
        ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
        error: timedOut ? '分析生成超时，可稍后重试；如反复超时请缩小问题范围。' : ('网络异常：' + String(resp.__err.message || resp.__err)),
        meta: collectedMeta, news: newsRefs,
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      return finish({ ok: false, error: `LLM ${resp.status}`, detail: errText.slice(0, 200), meta: collectedMeta });
    }

    const j = await resp.json().catch(() => null);
    if (!j) {
      return finish({
        ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
        error: '模型返回解析失败，请稍后重试。', meta: collectedMeta, news: newsRefs,
      });
    }
    const content = j.choices?.[0]?.message?.content || '';
    const finishReason = j.choices?.[0]?.finish_reason || '';
    const truncated = finishReason === 'length';

    // 空内容(上游偶发返回空串) → 结构化降级,避免把空当成成功结果下发
    if (!content.trim()) {
      return finish({
        ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
        error: '模型未返回有效内容，请稍后重试。', meta: collectedMeta, news: newsRefs,
      });
    }

    // 解析模型返回的 JSON（容错：剥离 ```json 包裹 + 截断补齐）
    const parsed = parseLLMJson(content);
    const result = parsed.value || { raw: content, truncated };

    if (!streaming) res.status(200);
    // ★服务端兜底纠偏(hold_advice / review / t_advice):LLM 偶尔无视手数上限/合法价带,
    //   这里强制拉回,避免给出"清仓4手(实际只持3手)"或"止损价低于跌停价"这类不可执行的建议。
    if ((mode === 'hold_advice' || mode === 'review' || mode === 't_advice') && result && typeof result === 'object' && !result.raw) {
      try {
        const hq = Number(payload.holdQty);
        const tq = payload.todayQuote || {};
        // 只有实时(盘中)且给了合法价带时才做价格夹取;盘前/盘后 limit* 为 null,
        //   Number(null)===0 会被误判为有限值把价格夹到 0,故用 == null 显式排除。
        const lo = (tq.limitDownPrice == null) ? NaN : Number(tq.limitDownPrice);
        const hi = (tq.limitUpPrice == null) ? NaN : Number(tq.limitUpPrice);
        const notes = [];
        // (1) 手数不得超过实际持仓
        const clampQtyField = (field) => {
          if (!(Number.isFinite(hq) && hq > 0 && typeof result[field] === 'string')) return;
          const m = result[field].match(/(\d+)\s*手/);
          if (!m) return;
          const n = parseInt(m[1], 10);
          const isClear = /清仓/.test(result[field]);
          if (isClear && n !== hq) {
            result[field] = result[field].replace(/\d+\s*手/, hq + '手');
            notes.push(`已按你的真实持仓${hq}手校正清仓数量`);
          } else if (!isClear && n > hq) {
            result[field] = result[field].replace(/\d+\s*手/, hq + '手');
            notes.push(`卖出手数不能超过持仓${hq}手,已校正`);
          }
        };
        // opQty(hold_advice/review 文案手数)
        clampQtyField('opQty');
        // (1b) 底仓为 0(反T已全部卖出未接回):绝对不能再出现任何"卖出/减仓/清仓X手"的建议。
        //   LLM 仍可能把之前卖掉的手数当成还持有("剩余X手拿到收盘/X手清掉"),这里强制纠偏。
        if (Number.isFinite(hq) && hq === 0) {
          const openT = Number(payload.openTNet) || 0; // 负=反T卖出未接回手数
          const soldBack = Math.abs(openT);
          const scrub = (field) => {
            if (typeof result[field] !== 'string') return;
            // 命中"卖/减/清仓...手""拿到收盘""继续持有""让利润跑"等基于"手上有货"的错误指令 → 改写为"接回"口径
            if (/(卖出|减仓|清仓|减半|拿到收盘|拿到尾盘).*?手|清掉|清仓|继续持有|保留持有|让利润(跑|奔跑)|封住.*持有|持有\s*\d+\s*手/.test(result[field])) {
              result[field] = soldBack > 0
                ? `底仓已被反T全部卖出、当前0手在手，无可卖/可持底仓；应择机把之前卖出的${soldBack}手在更低价接回(先买)以完成这笔反T`
                : `当前0手在手，无可卖底仓，不宜再做卖出操作`;
              notes.push('底仓为0(反T未接回),已纠正持有/卖出类指令为接回口径');
            }
          };
          ['opQty', 'actionPlan', 'nextAction', 'headline', 'title', 'reason', 'plain', 'keyLevel', 'invalidation'].forEach(scrub);
          // review:底仓0时 stance 不能是"持有/减仓/清仓",强制拉到"加仓"(接回也算加仓方向)或"观望"
          if (mode === 'review' && soldBack > 0 && /持有|减仓|清仓/.test(String(result.stance || ''))) {
            result.stance = '加仓';
            result.tone = 'red';
            notes.push('底仓为0(反T未接回),stance已从持有/减仓类改为加仓(接回)');
          }
          // review opQty 若仍是"持有/减仓/清仓X手",直接改写为接回口径
          if (mode === 'review' && soldBack > 0 && typeof result.opQty === 'string' && /持有|减仓|清仓/.test(result.opQty)) {
            result.opQty = `接回${soldBack}手`;
          }
          // t_advice:底仓0时禁止反T(先卖),方向只能是正向接回
          if (mode === 't_advice' && result.dir === 'reverse') {
            result.dir = 'positive';
            if (result.dirLabel) result.dirLabel = '接回未平反T(先买)';
            notes.push('底仓为0,反T方向已改为先买接回');
          }
        }
        // t_advice 反T卖出腿手数:suggestQty 是数字,反T时不能超过持仓
        if (mode === 't_advice' && Number.isFinite(hq) && result.dir === 'reverse'
            && result.suggestQty != null && Number(result.suggestQty) > hq) {
          result.suggestQty = hq;
          notes.push(`反T先卖手数不能超过持仓${hq}手,已校正`);
        }
        // (2) 价格必须落在 [跌停价, 涨停价] 合法带内,越界则夹回边界
        const clampPx = (v, label) => {
          const x = Number(v);
          if (!Number.isFinite(x)) return v;
          if (Number.isFinite(lo) && x < lo) { notes.push(`${label}低于跌停价,已上调至跌停价${lo}`); return lo; }
          if (Number.isFinite(hi) && x > hi) { notes.push(`${label}高于涨停价,已下调至涨停价${hi}`); return hi; }
          return x;
        };
        // hold_advice / review 共用价格字段
        if (result.addPrice != null) result.addPrice = clampPx(result.addPrice, '加仓价');
        if (result.reducePrice != null) result.reducePrice = clampPx(result.reducePrice, '减仓价');
        if (result.stopPrice != null) result.stopPrice = clampPx(result.stopPrice, '止损价');
        if (result.targetPrice != null) result.targetPrice = clampPx(result.targetPrice, '目标价');
        // t_advice 两腿价
        if (result.leg1Price != null) result.leg1Price = clampPx(result.leg1Price, '第一腿价');
        if (result.leg2Price != null) result.leg2Price = clampPx(result.leg2Price, '第二腿价');
        // review 关键价 support/resistance 不改(仅为参考位),但 keyLevel 是文案,不做数字夹取

        // (3) ★金额严格重算·不信任模型心算★
        //   资金额恒等于:手数 × 100股/手 × 参考价。模型常犯"15手×50.5元算成7575元(漏了×10)"这类错。
        //   这里按结构化字段重算 opAmount/planAmount,并把 actionPlan/nextAction 文案里的"约用XXXX元"就地改对。
        try {
          const round0 = (n) => Math.round(n);
          // 解析一段文字里的手数(取第一处"N手")
          const handsIn = (s) => { const m = typeof s === 'string' && s.match(/(\d+(?:\.\d+)?)\s*手/); return m ? parseFloat(m[1]) : null; };
          // 结构化动作 → 该用哪个参考价
          const act = String(result.action || result.stance || '');
          const isBuySide = /加仓|买入|买回|接回|试仓|试错|回调.*买|立即买/.test(act) || /买回|接回|加仓|买入/.test(String(result.opQty || ''));
          const isSellSide = /减仓|清仓|卖出/.test(act) || /减仓|清仓|卖/.test(String(result.opQty || ''));
          // buy_advice 用 buyPrice/planQty;hold_advice/review 用 add/reduce + opQty
          const refPxStruct = mode === 'buy_advice'
            ? Number(result.buyPrice)
            : (isBuySide ? Number(result.addPrice) : isSellSide ? Number(result.reducePrice) : NaN);
          const handsStruct = mode === 'buy_advice'
            ? Number(result.planQty)
            : (handsIn(result.opQty));
          // 3a. 重算结构化金额字段(opAmount / planAmount)
          const amtField = mode === 'buy_advice' ? 'planAmount' : 'opAmount';
          if (Number.isFinite(refPxStruct) && refPxStruct > 0 && Number.isFinite(handsStruct) && handsStruct > 0) {
            const correct = round0(handsStruct * 100 * refPxStruct);
            const prev = result[amtField];
            const prevNum = typeof prev === 'string' ? parseFloat(String(prev).replace(/[^\d.]/g, '')) : Number(prev);
            if (!Number.isFinite(prevNum) || Math.abs(prevNum - correct) > Math.max(1, correct * 0.02)) {
              result[amtField] = String(correct);
              notes.push(`资金额已按 ${handsStruct}手×100×${refPxStruct}元=${correct}元 严格重算`);
            }
          }
          // 3b. 修正文案里的"约用/约需/回笼 XXXX 元"——用文案自身的"N手"与"按X元"重算,避免漏乘/多乘
          const fixMoneyInText = (field) => {
            const t = result[field];
            if (typeof t !== 'string') return;
            const hands = handsIn(t);
            // 文案里的参考价:优先"按X元(估算/计算/挂单)",否则用结构化参考价
            let px = null;
            const pm = t.match(/按\s*([\d.]+)\s*元/);
            if (pm) px = parseFloat(pm[1]);
            else if (Number.isFinite(refPxStruct)) px = refPxStruct;
            if (!(hands > 0 && px > 0)) return;
            const correct = round0(hands * 100 * px);
            // 命中"(约|共|需|用|花|回笼|支出|买入|卖出)...数字元"里的金额并纠正(排除百分比/价位本身)
            result[field] = t.replace(/((?:约(?:需|用|花|支出|回笼)?|共|需|回笼|合计)\s*)([\d,]{3,})(\s*元)/g, (full, pre, num, suf) => {
              const v = parseFloat(num.replace(/,/g, ''));
              // 只纠"资金总额"量级(≥1000元且与正确值偏差>2%);价位类小数字不动
              if (Number.isFinite(v) && v >= 1000 && Math.abs(v - correct) > Math.max(1, correct * 0.02)) {
                notes.push(`${field}资金额 ${v}→${correct}(按${hands}手×100×${px}元严格重算)`);
                return pre + correct + suf;
              }
              return full;
            });
          };
          ['actionPlan', 'nextAction', 'reason', 'positionNote', 'plain'].forEach(fixMoneyInText);
        } catch { /* 金额重算失败不影响主流程 */ }

        if (notes.length) result.serverAdjust = notes.join('；');
      } catch { /* 兜底纠偏失败不影响主流程 */ }
    }
    // 明确输出「买入手数」的规范化整数字段:planQty 原文常为 "5手"/"约5手"/"5~8手" 等字符串,
    // 这里抽取首个整数为 planQtyNum,供自选卡「买入手数」直接消费,避免 Number() 得 NaN。
    if (mode === 'buy_advice' && result && result.planQty != null && result.planQtyNum == null) {
      const m = String(result.planQty).match(/-?\d+(?:\.\d+)?/);
      if (m) { const n = Math.trunc(Number(m[0])); if (Number.isFinite(n)) result.planQtyNum = n; }
    }
    return finish({
      ok: true,
      mode,
      model: useModel,
      updatedAt: Date.now(),
      result,
      truncated,
      news: newsRefs,
      // 可信度元信息：供前端展示共振灯/环境/龙虎榜/消息面(不依赖模型自报)
      meta: collectedMeta,
      usedRag: !!ragText,
      usage: j.usage || null,
    });
  } catch (e) {
    if (res.headersSent || (res.getHeader && String(res.getHeader('Content-Type') || '').includes('event-stream'))) {
      try { res.write(`event: result\ndata: ${JSON.stringify({ ok: false, error: String(e.message || e) })}\n\n`); } catch { /* ignore */ }
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}
