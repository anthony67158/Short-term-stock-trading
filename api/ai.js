// AI 分析代理：服务端调用 LLM，Key 从环境变量读取，绝不暴露给前端
// POST body: { mode: 'market'|'sector'|'stock'|'scan', payload: {...} }
import { buildCorpus, retrieve } from './_rag.js';
import { techSummaryForAI, fetchQuantPredict, backtestSignal } from './_ta.js';

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

const SYSTEM_PROMPT = `你是一位专业的A股短线交易策略分析师。你的任务是基于用户提供的【实时行情数据】做客观分析。

严格规则（必须遵守）：
1. 只能引用用户在数据中提供的真实股票、板块、数值。绝对禁止虚构任何股票代码、名称、价格或数据。
2. 如果数据不足以支撑某个结论，明确说"数据不足"，不要编造。
3. 你的分析是"资金面/情绪面/量价"的客观解读，不是买卖指令。
4. 面向短线（1-5日）视角：关注资金流向、连板梯队、量能、换手、板块强弱。
5. 保持简洁、结构化、有逻辑依据，每个观点都要能追溯到给定数据。
6. 若提供了【RAG检索资料】（近5日走势、主营、联网新闻），务必结合消息面/基本面一起分析。

你必须只输出一个合法的 JSON 对象（不要 markdown 代码块包裹），结构见用户要求。`;

// 顶级操盘军师人设：用于 做T/加减仓/买入/持仓建议/复盘/定价 等深度个股研判
const ADVISOR_SYSTEM = `你是用户的【顶级操盘军师】——一位浸淫A股短线二十年、把消息面、宏观面、资金面、技术面、盘口全部融会贯通的实战高手，像股神一样一眼看透一只票此刻的多空博弈。用户把真金白银的买卖决策托付给你，你必须给出果断、专业、可直接照做的判断，但绝不自欺——好就是好、烂就是烂、看不清就说看不清。

【重要·权重原则】技术面只是"择时工具"，真正决定短线生死的是【消息面+宏观面+资金面】。不要让技术信号(金叉/多头)主导结论；技术面服务于择时，方向要由消息、宏观、资金共同决定。若消息/宏观与技术冲突，以消息/宏观为主、技术为辅。

你的分析必须【多面合参】，每条结论都要引用给定数据里的具体数字：
1. 【消息面·个股】newsHeadlines/newsDigest(个股新闻/公告/催化/风险)——有减持/问询/立案/解禁/预亏/诉讼等利空，即使技术面再好也必须降级甚至回避；有明确催化(订单/中标/重组/业绩超预期)才可加分。这是第一优先。
2. 【宏观·国内外】macroNews(当日国内外重大事件：政策/央行/关税/地缘/美股/商品/行业政策等)——判断当前是风险偏好上升还是避险；结合该股所属板块，说清宏观是顺风还是逆风。宏观逆风时全面降级。
3. 【资金面】主力净流入/流出(stockFund.mainNetYi，注意asOfDate是哪天、isHistorical是否为收盘数据)、近5日主力序列(trend5)与流入天数(inflowDays)——判断主力是持续进货还是出货，一天的数字不算数，看5日趋势。
4. 【龙虎榜/席位】lhb(是否上榜、买方席位、smartMoney)——判断是不是聪明钱在买，还是跌停接盘/散户。
5. 【技术面·仅择时】maCross金叉死叉、maTrend多头空头、RSI/KDJ/布林/支撑压力——只用来确定"买卖点位与止损位"，不用来定方向。
6. 【量化模型】quant走势预测作为客观概率参照。

【必须遵守的可信度铁律】：
- 【今日实时优先·最高】若数据里有 todayQuote(今日实时行情)，它是"当下事实"，优先级高于一切历史指标。tech(技术面)、stockFund(主力资金)、backtest 均为昨日收盘口径、会滞后，与今日实时矛盾时【一律以今日实时为准】。特别地：**个股今日已涨停→今日主力大幅流入、极强，绝不能喊"下午/明日继续减仓/反弹卖出"，那是拿昨天的旧数据自相矛盾；涨停后应讲"封住则持有看连板、炸板放量再减"，任何减仓价必须在现价上方**；今日大涨(>7%)同理，昨日"空头/流出"结论已过期。今日跌停→别喊反弹买入。
- 【消息宏观定方向】方向判断必须先看消息面+宏观面，再用技术面择时。分析里必须明确交代"消息面+宏观对该股是利好/利空/中性"，不能只堆技术指标。
- 【择时择股分离·核心】大盘/宏观弱是【择时】信号，只用来压【仓位】(marketEnv.suggestPosition)，绝不用来一刀切否决【个股方向】。大盘弱≠所有票都观望——弱市里逆势强票(counterTrend.isStrong=抗跌/资金逆势流入/多头创新高)恰恰是资金抱团的龙头，应【优先给"小仓做多"的具体买点】，而不是一律观望。真正该回避的是：技术破位、主力持续出逃(trend5连续为负)、有明确利空的弱票。
- 【敢于看多】共振分≥2且个股结构不坏，就应给出明确的做多/买入结论(可标注小仓)，不要因为"大盘弱/不够完美"就习惯性观望。观望要有具体理由(破位/资金出逃/利空/盈亏比太差)，不能拿"大盘不好"当万能挡箭牌。每次分析后自检：如果因为大盘弱而给观望，但个股本身是逆势强票，请改判为"小仓做多"。
- 【盈亏比前置】买入/加仓/做T先算盈亏比(目标÷止损)，<1.8:1 才不值得做；≥1.8:1 且方向对就可以做。
- 【必列反方】诚实给出"我可能错在哪(bearCase)"和"什么信号出现就证明错了、必须离场(invalidation)"。
- 【承认不确定】上涨概率60%意味着40%会错；信心(confidence)要与共振分/消息面/宏观一致，不许无脑"高"，也不许无脑"低"。
- 资金数据 isHistorical=true 时说明用的是最近收盘(asOfDate)数据，按"收盘后、为下一交易时段准备"口径，别说成实时；盘口委比仅盘中有效。
- 所有价位具体、可成交；语言像师傅带徒弟一针见血，但只输出用户要求的合法 JSON（不要 markdown 代码块包裹）。`;

function buildUserPrompt(mode, payload, ragText) {
  const data = JSON.stringify(payload, null, 0);
  const ragBlock = ragText ? `\n\n【RAG检索资料：近5日走势+主营+联网新闻】\n${ragText}` : '';
  // 军师五面数据说明：把技术金叉多头、主力资金、盘口、消息面、龙虎榜、大盘环境、共振分全部显式点名，强制引用
  const advisorData = `${payload.todayQuote ? `\n【★今日实时行情(最高优先·当下事实)】现价${payload.todayQuote.price}、今日涨跌${payload.todayQuote.pct >= 0 ? '+' : ''}${payload.todayQuote.pct}%${payload.todayQuote.isLimitUp ? '、【已涨停】' : payload.todayQuote.isLimitDown ? '、【已跌停】' : ''}${payload.todayQuote.bigMove && !payload.todayQuote.isLimitUp && !payload.todayQuote.isLimitDown ? `、【当日大幅${payload.todayQuote.pct >= 0 ? '异动上涨' : '异动下跌'}】` : ''}、量比${payload.todayQuote.volRatio ?? '—'}、换手${payload.todayQuote.turnover ?? '—'}%。
⚠️数据时效铁律：下面的 tech(技术面均线/金叉)、stockFund(主力资金)、backtest 都是【昨日收盘口径】，会滞后！必须以本行"今日实时行情"为当下事实基准，两者矛盾时【以今日实时为准】。
${payload.todayQuote.isLimitUp ? '⚠️该股【今日已涨停】：说明今日主力大幅流入、多方极强，绝不能因为昨日"空头排列/主力流出"就喊"下午/明日继续减仓"——那是自相矛盾。涨停后正确视角是:看能否封住/连板→持有；炸板/开板放量→再考虑减。给出的减仓价必须高于现价(涨停价附近冲高兑现)，不能低于现价。' : ''}${payload.todayQuote.isLimitDown ? '⚠️该股【今日已跌停】：多方极弱，别喊"反弹买入"，以止损/离场为主。' : ''}${(payload.todayQuote.bigMove && payload.todayQuote.pct >= 7 && !payload.todayQuote.isLimitUp) ? '⚠️该股【今日大涨】：今日资金明显流入，昨日的"空头/流出"结论已过期，别据此喊减仓；应按"强势股冲高兑现或持有看延续"来判断。' : ''}` : ''}${payload.marketPhase ? `\n【当前时段】${payload.marketPhase}` : ''}${payload.marketEnv ? `\n【大盘环境】${payload.marketEnv.level}(环境分${payload.marketEnv.score})。${payload.marketEnv.note}` : ''}${payload.resonance ? `\n【信号共振】共振分 ${payload.resonance.score}/${payload.resonance.max}，命中:[${(payload.resonance.hits || []).join('、')}]。共振分≥2即可考虑小仓做多、≥4可正常仓位；<2才观望。共振不足不等于必须观望——若个股是逆势强票仍可小仓试多。${payload.resonance.hasNegNews ? '注意:消息面检测到潜在利空词，务必核查。' : ''}` : ''}${payload.counterTrend ? `\n【逆势强票判定】${payload.counterTrend.note}` : ''}${payload.tech ? `\n【技术面 tech(昨日收盘口径,可能滞后)】含 maCross(金叉/死叉)、maTrend(多头/空头排列)、macd、rsi、kdj、boll、支撑support/压力resistance、ATR。务必点名是否金叉、是否多头排列；但若与今日实时行情矛盾，以实时为准。` : ''}${payload.stockFund ? `\n【个股资金面 stockFund(截至asOfDate=${payload.stockFund.asOfDate || '—'},${payload.stockFund.isHistorical ? '昨日收盘口径' : '实时'})】mainNetYi=主力净流入(亿)、trend5=近5日主力净额序列(亿)、inflowDays=近5日流入天数、main5dYi=5日累计、weibi=盘口委比%。看5日趋势判断主力持续进货还是出货；若今日已涨停/大涨，说明今日资金大幅流入，昨日流出数据已过期。` : ''}${payload.lhb ? `\n【龙虎榜 lhb】近30日上榜${payload.lhb.times30d}次，最近${payload.lhb.date}，买方席位:[${(payload.lhb.buySeats || []).join('、')}]，smartMoney=${payload.lhb.smartMoney}(${payload.lhb.smartMoney ? '有知名游资/机构' : '无明显知名席位'})。` : ''}${(payload.macroNews && payload.macroNews.length) ? `\n【宏观·国内外要闻(必须纳入分析)】${payload.macroNews.join(' | ')}。请判断当前宏观是风险偏好还是避险、对该股所属板块是顺风还是逆风。` : ''}${(payload.newsHeadlines && payload.newsHeadlines.length) ? `\n【个股消息面头条】${payload.newsHeadlines.join(' | ')}` : ''}${(payload.newsDigest && payload.newsDigest.length) ? `\n【个股消息面摘要】${payload.newsDigest.join(' ')}` : ''}${payload.backtest ? `\n【信号回测】${payload.backtest.note}。命中率低时不要只凭金叉看多。` : ''}${payload.quant && payload.quant.forecast ? `\n【量化预测可信度】上涨概率${payload.quant.forecast.upProb}%仅是统计概率，务必结合回测命中率与共振分判断可信度，别当承诺。` : ''}`;
  if (mode === 'market') {
    return `【今日盘面实时数据】\n${data}\n\n请输出 JSON：{"sentiment":"多头/中性/空头","score":0-100的情绪分,"summary":"一句话盘面总结","mainLines":[{"name":"最强主线板块名","reason":"资金/涨停依据"}],"risks":["风险点1","风险点2"],"advice":"短线操作建议(仓位/节奏)"}`;
  }
  if (mode === 'sector') {
    return `【板块「${payload.sectorName}」实时数据+成分股】\n${data}\n\n请从上面【真实成分股列表】中挑选最多3只短线关注度高的个股（必须是列表里存在的），输出 JSON：{"sectorView":"该板块资金/强弱判断","picks":[{"name":"股票名(必须来自列表)","code":"代码","reason":"入选逻辑(资金/量价/连板)","watch":"短线关注点/风险"}],"note":"整体提示"}`;
  }
  if (mode === 'stock') {
    return `【个股实时数据】\n${data}${ragBlock}\n\n请综合实时数据与RAG资料（消息面/近5日走势），输出 JSON（各字段填你的分析结论，不要照抄字段说明）：{"name":"股票名","view":"用一句话给出资金面+量价+消息面的综合判断结论","strength":"强或中或弱三选一","points":["解读要点1","解读要点2","解读要点3"],"newsImpact":"最新消息面对短线的具体影响；若近期无重要消息则写'近期无重要消息'","watch":"短线关注点与风险"}`;
  }
  if (mode === 'scan') {
    return `【当日全盘综合数据：大盘情绪 + 板块资金流 + 涨停连板 + 盘中异动】\n${data}\n\n你是短线策略总监，请综合以上所有维度，给出今日最值得关注的 TOP3 方向。输出 JSON：{"marketMood":"一句话大盘定调","topDirections":[{"rank":1,"direction":"方向/板块名","logic":"入选逻辑(必须结合资金流/涨停/异动的具体数据)","representStocks":[{"name":"代表股(必须来自给定数据)","code":"代码"}],"strength":"强/中/弱"}],"strategy":"今日短线操作策略(仓位/节奏/风格)","topRisk":"最需警惕的风险"}`;
  }
  if (mode === 'scan_pick') {
    return `【AI 选股请求】用户不知道今天买哪只，需要你从"已用量化模型打过分的候选池"里，结合大盘/板块/盘面，精选出今日最值得买的 **3 只** 个股，并说清怎么买。
数据含：大盘情绪(market)、板块资金流(sectors)、【候选池 candidates —— 每只都带量化打分与走势预测】。
数据：${data}

【候选池 candidates 字段说明】每只含：name/code、pct当日涨幅、量价(turnover换手/volRatio量比/mainInflowYi主力净流入亿)、tags信号(涨停/连板/主力抢筹/涨速)、以及量化模型结果 quant{ score综合分0~100越高越偏多, bias偏多/偏空/中性, upProb未来5日上涨概率%, expRet预期涨跌%, targetLow~targetHigh目标价区间 }。

【选股逻辑，逐条执行】：
1. **先看大盘与板块**：逆风(跌多/跌停多)则从严、甚至提示今日不宜追高；顺风则积极。优先落在强势主线板块里的票。
2. **量化优先**：candidates 里 quant.score 高(≥60)、upProb 高(≥55%)、expRet 为正的，是量化看好的；score 低/看跌的坚决排除。量化是硬门槛。
3. **量价与题材验证**：在量化过关的基础上，选有资金(主力净流入)、有量能(量比适中放量)、属于当日主线、位置不过高(别追已连板高位接盘)的。
4. **可买性**：给出明确买点(回踩不破/放量突破/开盘竞价)和参考买入价区间(可结合 quant 目标区间下沿)，以及止损位。

【硬要求】：精选正好 3 只(若实在符合的不足3只，可少给并说明)，必须来自 candidates 里的真实个股，理由必须引用该股的量化分/上涨概率/资金等具体数字。

请输出 JSON：{"marketNote":"一句话今日大盘环境与选股基调","picks":[{"rank":1,"name":"股票名","code":"代码","quantScore":量化分数字,"reason":"为什么选它(引用量化分/上涨概率/资金/板块的具体数字，大白话)","buyPoint":"买点(如回踩5日线不破/放量突破X/竞价低吸)","buyZone":"参考买入价区间(如 12.3~12.8)","target":"目标位/预期","stop":"止损位","risk":"该股主要风险"}],"note":"整体提示(仓位/节奏)"}。只输出 JSON。`;
  }
  if (mode === 'daily') {
    return `【当日全盘数据：大盘情绪 + 板块资金流 + 涨停连板 + 盘中异动】\n${data}\n\n你是短线操盘手，服务做 T+1（今买明卖）的用户。请综合所有维度，直接给出今日可执行的操盘决策。输出 JSON：{"canTrade":"能做/谨慎/空仓 三选一","light":"green/yellow/red","verdict":"一句话今日定调(能不能做、什么风格)","direction":"今日主攻方向(1-2个板块/主线)","candidates":[{"name":"候选股(必须来自给定数据)","code":"代码","reason":"入选逻辑(结合资金/涨停/异动的具体数据)","buyPoint":"买点提示(如回踩不破/放量突破)","expect":"次日预期","stop":"止损提示"}],"position":"建议仓位(如3-5成)","risk":"最需警惕的风险"}。candidates 给3-5只，必须来自给定数据里的真实个股。`;
  }
  if (mode === 't_advice') {
    const styleMap = {
      conservative: '【稳健】只在明确支撑/压力位出手，手数小(建议底仓1/4左右)，价位留足安全边际，宁可少做也不冒进；大盘或个股不明朗时直接建议观望。',
      balanced: '【均衡】常规高抛低吸，手数适中(建议底仓1/3左右)，在合理支撑压力间做T。',
      aggressive: '【激进】追求弹性和更大差价，手数可较大(建议底仓1/2，日内强势可更多)，敢在放量拉升中追、急跌企稳中抢反弹，价位更贴近现价，博更大波段；但仍必须给出失效止损位。',
    }
    const isAuto = !payload.style || payload.style === 'auto'
    const styleText = isAuto
      ? '【自动】用户没有指定风格，请你根据 stockProfile(这只股自己的历史规律) 自动选定最合适的风格：波动大/振幅大的妖股→偏激进博差价；温吞小波动→偏稳健小做；居中→均衡。并在 chosenStyle 字段回填你选的风格。'
      : (styleMap[payload.style] || styleMap.balanced)
    return `【做T参考请求】用户持有一只票想日内做T摊薄成本。做T有两个方向，你要根据此刻盘面对称判断、不要默认只做正T：正T=先低吸后高抛(现价偏低时)，反T=先高抛后低接(现价偏高/浮盈时)。数据含：个股实时量价、当日分时结构(intraday: vwap均价/日内高低/现价位置posInDay/节奏rhythm/是否触及日内高低)、大盘情绪(market)、大盘资金流向(marketFlow)、个股近20日走势(history)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带/RSI/KDJ/MACD/支撑压力/买卖带/止损止盈)】、用户持仓(holdCost/holdQty/baseQty)。
数据：${data}${advisorData}

【个股历史规律画像 stockProfile —— 本次策略自适应的核心，务必逐项参考】
这是根据该股近${payload.stockProfile ? payload.stockProfile.days : 60}日日线统计出的“这只股自己的性格”，含义：
- avgAmplitude/recentAmplitude：平均/近10日日内振幅%。振幅大=做T空间大值得做；recentAmplitude<2.5 基本没肉，应倾向观望或轻仓。
- volatility：日涨跌幅标准差(性格烈度)。越大越是“妖股脾气”→越适合激进；越小越温吞→越适合稳健。
- bigUpRevRate/bigDnRevRate/meanRevScore：大涨后回落概率 / 大跌后反弹概率 / 综合均值回归分。分数高(≥0.55)=强均值回归，特别适合“涨了就抛、跌了就吸”的高抛低吸做T。
- lowOpenUpRate/highOpenDownRate：历史上“低开走高”/“高开走低”的频率。前者高→这只股正T低吸胜率高；后者高→反T高抛更契合。
- volPriceSync：放量日里上涨占比。高=放量可信可追；低=放量常是出货，追高需谨慎。
- streak：当前连阳(正)/连阴(负)根数；posIn20/posIn60：现价在20/60日区间位置%。
- styleSuggest/dirBias/dirReason：系统按历史规律预判的风格与方向偏好，作为你的重要参考(你可结合当日盘面覆盖，但若覆盖必须说明理由)。

【用户选择的操作风格】${styleText}
${isAuto ? '你要基于历史规律自动决策，并在 chosenStyle 明确回填(conservative/balanced/aggressive 之一)。' : '你必须严格按这个风格给建议——激进就大胆给重手贴价、稳健就轻仓留边际。'}

【分析逻辑链，逐条结合数据，不许空谈】：
1. 历史规律(最重要)：先看 stockProfile 判断这只股“天生适合怎么做T”——是激进还是稳健、值不值得做(振幅够不够)、以及 dirBias 是偏正T/反T还是双向都行。注意 dirBias=balanced/meanReversion 时不要预设方向，方向由第3步的当日位置决定。
2. 大盘环境：用 market(涨跌比/涨停) + marketFlow(净额/流入流出) 判断顺风还是逆风，对历史规律结论做加减分。
3. 当日分时：用 intraday(现价 vs vwap均价、posInDay、rhythm、atDayLow/atDayHigh) 判断此刻是日内偏低还是偏高、什么节奏。这是落地到“今天此刻”的执行依据。
4. 支撑压力：优先采用 tech(专业技术指标) 里的 support/resistance/布林上下轨/buyZone/sellZone 作为做T的锚，再结合日内高低、均价线VWAP微调，给出具体的支撑位和压力位数字。tech.atr(真实波幅)决定两腿价差不要小于约1个ATR否则没肉、不要大于约3个ATR否则一天到不了。tech.rsi/kdj 超买则反T高抛更优、超卖则正T低吸更优。
5. 理论支撑：贴切引用一个理论(均值回归/趋势/支撑压力/量价/仓位管理)解释判断。${payload.quant ? `
6. 【量化模型深度融合 quant，必须与你的价位决策拧成一体，不要各说各话】：quant 有 score(0~100)、bias，以及**走势预测 forecast**(upProb未来5日上涨概率%、direction看涨/看跌/震荡、targetLow~targetHigh目标价区间、expRet预期涨跌%)。落地要求：
   - **量化定方向倾向**：forecast.direction=看涨→更偏正T(先低吸博后续上涨)、看跌→更偏反T(先高抛避回落)、震荡→区间高抛低吸皆可。若量化方向与你按分时位置判的方向冲突，以稳健为先(减小手数/收窄价差)并在 plain 里点明分歧。
   - **量化目标区间锚定两腿价**：leg2Price(目标腿)要参考 forecast 的目标价区间——正T的高抛目标别超过 targetHigh 太多(那是模型预期上沿，够不着)，反T的接回目标别低于 targetLow 太多。让两腿价位"落在量化认为大概率能到的区间内",这样你才跟得住、成交得了。
   - **量化定信心与手数**：upProb 高(≥60)且方向一致→信心高、手数可大;upProb 中性(45~55)→手数减半、只在明确支撑/压力才动;量化偏空(score≤40)且你想正T→明确降级为轻仓或观望。` : ''}

【方向必须对称判断，不得默认偏向正T——先看此刻现价在日内的位置(intraday.posInDay / vsVwap)】：
- **正T低吸(先买后卖)**：现价在日内区间偏低(posInDay 低、现价在VWAP下方)、触及/接近日内低点(atDayLow)、急跌企稳有支撑时。适合“手里有底仓、今天想低点补一手明天高抛摊成本”。
- **反T高抛(先卖后买)**：现价在日内区间偏高(posInDay 高、现价在VWAP上方)、触及/接近日内高点(atDayHigh)、冲高滞涨或大盘转弱时。适合“手里有底仓、趁高抛一部分等回落再接回、落袋并降成本”。**当用户持仓浮盈、或现价明显高于成本、或 posInDay≥60、或尾段拉升到日内高位时，要优先考虑反T高抛，而不是让他去追高低吸。**
- **观望(none)**：振幅太小(recentAmplitude<2.5)、震荡无边界、或极度逆风。
判定顺序：先用 intraday 的当日位置定“此刻更该先买还是先卖”，再用 stockProfile 的 dirBias/开盘路径做辅助验证。dirBias=balanced 时，完全以当日位置为准。不要因为“做T=高抛低吸”这个习惯说法就默认选正T——反T同样是做T，方向取决于此刻价格在日内的高低。

请输出 JSON：{"advisable":"适合/谨慎/不建议","light":"green/yellow/red","chosenStyle":"conservative或balanced或aggressive(你据历史规律选定的风格)","styleReason":"为什么给这只股选这个风格(必须引用stockProfile的具体数字，如振幅/波动率/均值回归分)","dir":"positive或reverse或none","dirLabel":"正T低吸 或 反T高抛 或 暂不做T","confidence":"高/中/低","actionPlan":"【最重要·一句话行动指令，让用户能直接照做】把方向+手数+两腿价位+触发条件揉成一句话，例如'现价X偏高，先在Y附近高抛N手，回落到Z附近接回，量化看跌upProb仅30%所以别追高'。必须含具体价格数字。","histPattern":"用一句话概括这只股的历史规律","plain":"用大白话解释为什么这么做(像师傅带徒弟，点出历史规律)","marketNote":"一句话大盘环境(引用数据)","stockNote":"一句话个股当下位置(引用分时vwap/日内位置/量比)","fundNote":"资金面依据(引用主力净流入/流出mainNetYi、盘口委比weibi，研判主力进出与盘口意愿)","support":支撑位数字,"resistance":压力位数字,${payload.quant ? '"quantNote":"量化走势预测如何影响这次决策(引用quant.score、forecast上涨概率与目标区间的具体数字，说明为什么两腿价定在这;用大白话)",' : ''}"theory":"引用的理论+一句话如何支撑","suggestQty":建议手数(整数,按风格),"leg1Price":第一腿参考价(数字),"leg2Price":第二腿目标价(数字,须落在量化目标区间内),"estProfit":"预估净赚(元)","estCostDown":"预估成本下降(元/股)","addOn":"激进风格可给加码条件;其他风格填空字符串","newsNote":"消息面(有利空点明,无则'无明显利空')","macroNote":"宏观/国内外影响(引用macroNews判断风险偏好/避险,及对该股板块是顺风还是逆风;无则'宏观中性')","seatNote":"龙虎榜/席位(有则点明smartMoney,无则'近期未上榜')","riskReward":"盈亏比(如 2:1)","resonanceScore":共振分数字(引用resonance.score),"bearCase":"【反方观点】可能错在哪","invalidation":"【失效信号】什么价一破就止损离场(含价格)","risk":"风险与失效止损价位"}。不建议做T时 dir=none、价位可 null；大盘弱只压手数(建议底仓更小比例)不禁做T，逆势强票/振幅够仍可做T。只输出JSON。`;
  }
  if (mode === 'plan') {
    return `【交易计划请求】用户持有一只票，想为它定一份短线交易计划(止盈价/止损价/买入理由)。用户不太懂技术，需要你基于**持仓成本**并结合技术指标给出默认建议，用户会再微调。
数据含：个股实时量价、当日分时(intraday)、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history: ma5/ma10/ma20、20日高低high20/low20)、**用户持仓成本 holdCost（本次定价的核心基准）**。
数据：${data}${advisorData}

【最高优先级 · 定价基准 = 持仓成本 holdCost】
用户要的是"相对我的成本能赚多少、亏多少"，不是相对现价。所以：
- **止盈价 tp 必须 > holdCost**，且至少覆盖买卖双边手续费后仍有正收益；短线合理目标为 holdCost × (1 + 8%~15%)。
- **止损价 sl 必须 < holdCost**，相对 holdCost 的最大回撤不超过约 8%（即 sl ≥ holdCost × 0.92）。
- 现价可能高于或低于成本（浮盈或套牢），但**都不改变上面两条铁律**：止盈永远在成本之上、止损永远在成本之下。

【技术位只用于"在上述区间内微调"，不能突破成本边界】
- 止盈：在"成本+8%~+15%"区间内，若上方有近20日高点/压力位/整数关口，可就近取这些技术位作为更现实的目标；但技术位若低于成本，则忽略它、直接用"成本+目标涨幅"。
- 止损：在"成本-8%以内"，若下方有 MA10/MA20/近20日支撑 low20，可取更靠上的那个技术支撑作为更早的离场点；但止损不得高于成本。

【硬约束（务必自检）】必须满足 sl < holdCost < tp；且 sl ≥ holdCost×0.92、tp ≥ holdCost×1.06；价位精度贴合该股量级(低价股可3位小数)。若技术位与上述冲突，一律以成本基准为准。

请输出 JSON：{"tp":止盈价数字,"sl":止损价数字,"reason":"一句话交易计划理由(说明相对成本的盈亏目标+技术依据)","tpBasis":"止盈依据(如:成本+10%/近20日高X)","slBasis":"止损依据(如:成本-8%/MA10 X)","theory":"引用的理论一句话","confidence":"高/中/低"}。只输出JSON。`;
  }
  if (mode === 'price') {
    const isBuy = payload.action === 'buy';
    const actLabel = { buy: '建仓(首次买入)', add: '加仓(补仓)', sell: '减仓/清仓(卖出)' }[payload.actionKind] || (isBuy ? '买入' : '卖出');
    return `【${isBuy ? '买入' : '卖出'}挂单价请求】用户正准备${actLabel}一只票，需要你给出一个**极其合理的${isBuy ? '买入' : '卖出'}挂单价**（一个具体数字），供他人工挂单参考。
数据含：个股实时量价(nowPrice=当前实时价、dayHigh/dayLow/open/prevClose)、当日分时(intraday: now实时价/vwap均价/日内高低/posInDay位置/rhythm节奏/是否触及日内高低)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带上下轨/RSI/KDJ/MACD/支撑support压力resistance/系统算好的买入带buyZone卖出带sellZone/止损stopLoss/止盈takeProfit)】、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history)${payload.holdCost ? '、用户当前持仓成本 holdCost' : ''}${payload.tradeHistory ? '、用户过往在这只股上的交易记录 tradeHistory(历史买卖价与盈亏，用于贴合他的操作习惯与成本带)' : ''}。
数据：${data}${advisorData}

【定价三大依据，缺一不可，且必须落到一个具体价格】：
1. **当前实时价(最高优先，锚)**：以 intraday.now / nowPrice 为基准锚，你的挂单价必须在实时价附近的合理区间，不能脱离盘口开虚价。${isBuy ? '买入价通常≤实时价(挂低吸单)，但不宜低于日内低点太多导致挂不上；急拉时可贴近实时价追。' : '卖出价通常≥实时价(挂高抛单)，但不宜高于日内高点太多导致挂不出；跳水时可贴近实时价出。'}
2. **历史规律(stockProfile)**：用 avgAmplitude/recentAmplitude 判断合理挂单偏离幅度(振幅大→可挂离现价远一点博差价，振幅小→贴近现价才成交)；用 lowOpenUpRate/highOpenDownRate/meanRevScore 判断这只股${isBuy ? '低吸' : '高抛'}的合适位置；用 posInDay/vwap 判断此刻贵不贵。
3. **过往交易记录(tradeHistory)**：${payload.tradeHistory ? '参考用户历史在这只股的买卖价位带与成本，给出与他习惯/成本相衔接的价格(如买入尽量低于其历史均价成本、卖出尽量高于其成本)。' : '本次无历史成交记录，按前两条定价。'}${payload.holdCost ? ` 用户当前持仓成本 holdCost=${payload.holdCost}${isBuy ? '，加仓价应能摊低或至少不显著抬高成本' : '，卖出价应尽量高于成本以锁定收益(除非止损)'}。` : ''}
4. **专业技术指标(tech)**：这是定价的技术锚，务必用它校准价格——${isBuy ? '买入价优先贴近 tech.buyZone(买入带)/布林下轨 tech.boll.lower/支撑 tech.support；若 RSI<30 或 KDJ 超卖或现价贴布林下轨，说明是低吸好位置可稍积极；用 ATR 判断挂单不要低于现价超过约1个ATR否则难成交。' : '卖出价优先贴近 tech.sellZone(卖出带)/布林上轨 tech.boll.upper/压力 tech.resistance；若 RSI>70 或 KDJ 超买或现价贴布林上轨，说明是高抛好位置可稍积极；用 ATR 判断挂单不要高于现价超过约1个ATR否则难成交。'} 你给出的价格应与 tech 的买卖带/支撑压力大体吻合，若明显偏离必须在理由里说明为什么。${payload.quant ? `
5. **量化模型(quant)**：多因子打分 quant.score(0~100越高越偏多)、quant.bias，以及**走势预测 quant.forecast**(upProb未来5日上涨概率%、expRet预期涨跌%、targetLow~targetHigh目标价区间、direction看涨/看跌/震荡)。${isBuy ? '预测看涨且上涨概率高(≥58)时买入可略积极贴近现价；看跌或概率低(≤42)则买入更保守、或干脆等回调。' : '预测看跌时卖出可略积极尽快出；看涨则卖价可挂高一点等冲高。'} 目标价区间可作为你止盈/接回价的参考。量化与技术面冲突时以稳健为先并点明分歧。` : ''}

【要求】只给一个最优挂单价 price(数字，精度贴合该股量级，低价股可3位小数)，并给一个可选的备用价 altPrice(更积极成交或更保守的另一档)。价格必须合理、可成交、有依据。

请输出 JSON：{"price":挂单价数字,"altPrice":备用价数字或null,"side":"${isBuy ? 'buy' : 'sell'}","anchor":"相对实时价的说明(如:实时X，挂低吸X/挂高抛X)","reason":"一句话大白话理由(点出实时价+历史规律+交易记录如何支撑这个价)","histNote":"历史规律如何影响定价(引用振幅/回归/开盘路径的具体数字)","techNote":"技术指标如何支撑这个价(引用布林/ATR/RSI/支撑压力的具体数字，用大白话)"${payload.quant ? ',"quantNote":"量化模型打分如何印证或修正(引用quant.score与bias，用大白话)"' : ''},"confidence":"高/中/低"}。只输出JSON。`;
  }
  if (mode === 'hold_advice') {
    return `【持仓个股操作建议请求】用户持有一只票，需要你像贴身操盘顾问一样，明确告诉他现在该 **加仓 / 减仓 / 持有 / 清仓**，并且**给出具体的参考价位（一个数字或一个窄区间）**让他能直接照着挂单。这是持仓管理决策，不是做T。
${payload.openTNet ? `【重要·持仓口径】holdCost/holdQty 已按【实时持仓】计算——用户有未结算的做T腿，净${payload.openTNet > 0 ? '买入' : '卖出'}${Math.abs(payload.openTNet)}手在做T未结算前【就当作已经${payload.openTNet > 0 ? '加仓' : '减仓'}】计入了当前持仓(手数与成本都已反映)。请直接以这个 holdQty=${payload.holdQty}手、holdCost=${payload.holdCost} 为当前真实持仓来判断加/减/持有/清仓，不要再把那部分当"待结算做T"。` : ''}
数据含：个股实时量价(nowPrice/dayHigh/dayLow/open/prevClose)、当日分时(intraday: now实时价/vwap均价/日内高低/posInDay位置/rhythm节奏/是否触及日内高低)、大盘情绪(market)、资金流向(marketFlow)、个股近20日走势(history: ma5/ma10/ma20、20日高低)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带上下轨/RSI/KDJ/MACD/支撑support压力resistance/买入带buyZone卖出带sellZone/止损stopLoss/止盈takeProfit)】、**用户持仓成本 holdCost 与手数 holdQty（决策基准，已含未结算做T净腿）**${payload.account && payload.account.totalAssets ? `、账户总资产${payload.account.totalAssets}元${payload.account.cash != null ? '/可用' + payload.account.cash + '元' : ''}${payload.account.position != null ? '/当前总仓位' + payload.account.position + '%' : ''}${payload.account.stockWeight != null ? '/该股当前占总资产' + payload.account.stockWeight + '%' : ''}(用于按账户全景算补仓金额、仓位占比、最多可买几手)` : ''}${payload.quant ? '、量化模型 quant(score多因子分/bias/forecast走势预测)' : ''}。
【账户全景优先】若给了 account.totalAssets / account.cash / account.position / account.stockWeight，你必须先按账户约束算建议，而不是只按K线拍脑袋：
- 加仓：先判断可用资金 account.cash 最多还能买几手(整数手=100股)，再按 marketEnv.suggestPosition 与该股当前占比 stockWeight 判断是否该补；弱市/单票占比已偏高时，只能小补或不补。
- 减仓：若单票占比 stockWeight 已过高，优先给减仓几手把单票降到更合理区间；别只说“减仓”，要明确减几手、减完后仓位大概降到多少。
- 持有：也要说清楚“为什么此刻不动”，以及若要再加/再减，分别在什么仓位线触发。
- 所有手数必须是 **100股整数手**，且不能超过 holdQty 或 cash 能支持的上限。
【把账算清楚·必做】给加仓/减仓建议时，务必算出：操作手数、约需/回笼资金(=价×手数×100)、操作后新成本、到目标价的预期收益(元+%)、到止损的亏损额、盈亏比${payload.account && payload.account.totalAssets ? '、操作后该股占账户仓位%' : ''}，让用户能直接照做，而不是只说"可加仓"。
【账户约束·必做】若提供了 account：
- 先根据 account.cash 算出本次最多还能买几手；加仓手数不能超过这个上限。
- 再根据 marketEnv.suggestPosition + account.position(当前总仓位) + account.stockWeight(该股当前占比) 决定本次到底给 0/1/2/3…手，而不是空泛地说“适量”。
- 默认把单票控制在总资产的合理范围：弱市尽量不超过约10%~15%，中性市约15%~20%，强市龙头可放宽但仍要讲清楚理由；若当前 stockWeight 已偏高，优先减仓/持有，不要继续建议重仓加。
- 若是做T/减仓，也要结合 holdQty 给出可执行的整数手数，不能超过当前手数。
数据：${data}${advisorData}

【决策逻辑，逐条结合数据，不许空谈】：
1. **先算盈亏**：用 nowPrice 与 holdCost 比，判断此刻是浮盈还是套牢、幅度多少。这决定基调：浮盈可考虑落袋/减仓，套牢要看该补还是该止损。
2. **趋势与位置**：用 history(均线多空/20日区间位置) + tech(布林/RSI/KDJ/MACD/支撑压力) + intraday(现价vs均价/日内位置) 判断这只股现在是强势该拿住、还是转弱该减、还是超跌可补。
3. **历史规律 stockProfile**：用振幅/波动率/均值回归分/连阳连阴，判断这只股"性格"——是追涨型还是回归型，辅助决定加减仓的价位偏离度。
4. **大盘环境**：market/marketFlow 顺风则可积极持有/加仓，逆风则优先减仓控风险。${payload.quant ? `
5. **量化走势预测 quant.forecast**：upProb(未来5日上涨概率%)、direction(看涨/看跌/震荡)、targetLow~targetHigh(目标价区间)、expRet(预期涨跌%)。看涨且上涨概率高(≥58)→倾向持有或回踩加仓、加仓价可参考现价或回踩支撑；看跌(≤42)→倾向减仓/清仓、减仓价可贴近现价或反抽压力尽快出；震荡→高抛低吸波段管理。量化目标区间用来锚定你给的加/减仓价位。` : ''}

【价位要求——必须落到可挂单的具体数字】：
- **加仓价 addPrice**：给一个回踩买点（通常≤现价，贴近 tech.buyZone/布林下轨/支撑位/MA10；能摊低或不显著抬高 holdCost），振幅大可挂离现价远些、振幅小要贴近现价才成交。
- **减仓价 reducePrice**：给一个反弹卖点（通常≥现价，贴近 tech.sellZone/布林上轨/压力位；尽量高于 holdCost 锁定收益）。
- **止损价 stopPrice**：跌破则无条件离场（通常 holdCost×0.92 与最近关键支撑取较高者）。
- 根据你的决策(action)，主推的那个价位要给准；不主推的价位也尽量给出以便用户参考。价格精度贴合该股量级(低价股可3位小数)，且必须与 tech 的买卖带/支撑压力大体吻合，明显偏离要在理由里说明。

请输出 JSON：{"action":"加仓 或 减仓 或 持有 或 清仓","tone":"red(偏多/加仓/持有强势) 或 green(偏空/减仓/清仓) 或 muted(观望/持有中性)","title":"一句话结论(如:可小幅减仓锁利 / 回踩可加仓 / 继续持有)","pnlNote":"当前相对成本的盈亏情况(引用现价与holdCost的具体数字)","actionPlan":"【最重要·一句话可直接照做的行动指令】把动作+手数(或仓位比例)+参考价位+触发条件揉成一句话，必须含具体价格数字，例如'现价X已浮盈Y%，可在Z附近减2手锁利，跌破W则清仓止损'。","addPrice":加仓参考价数字或null,"reducePrice":减仓参考价数字或null,"stopPrice":止损价数字或null,"targetPrice":目标位/预期价数字或null,"opQty":"本次建议操作，必须写清动作+手数：加仓X手/减仓X手/清仓X手/做T X手；若本次不动，必须填'无需操作'，禁止填'0'、'0手'、'持有0'这类含糊值","opAmount":"本次约需/回笼资金(元,=操作价×手数×100;加仓为支出、减仓为回笼)","newCost":"加/减仓后的新持仓成本(数字;持有则填'不变')","expReturn":"预期收益(按holdQty到targetPrice能赚多少元、约+N%)","riskAmount":"到stopPrice会亏多少元","posAfter":"${payload.account && payload.account.totalAssets ? '操作后该股占账户仓位%(用account.totalAssets算)' : '相对仓位描述(总资产未填)'}","reason":"大白话理由(结合盈亏+趋势+位置+量化，说清为什么这么做、价位为什么定在这)","techNote":"技术面依据(必须点名当前是否金叉/是否均线多头排列，并引用RSI/布林/支撑压力的具体数字)","fundNote":"资金面依据(引用主力净流入/流出mainNetYi、5日主力main5dYi、盘口委比weibi的具体数字，研判主力进货还是出货)","newsNote":"消息面研判(引用newsHeadlines/newsDigest；有利空必须点明；无则写'近期无明显利空')","macroNote":"宏观/国内外影响(引用macroNews判断风险偏好/避险,及对该股板块是顺风还是逆风;无则'宏观中性')","seatNote":"龙虎榜/席位(lhb有则点明smartMoney；无则'近期未上榜')"${payload.quant ? ',"quantNote":"量化走势预测如何支撑(引用score/upProb/目标区间的具体数字，大白话)"' : ''},"riskReward":"盈亏比(预期收益空间÷止损空间，如 2.5:1)","positionNote":"仓位建议(结合marketEnv.suggestPosition)","resonanceScore":共振分数字(引用resonance.score,0-6),"bearCase":"【反方观点】这个判断可能错在哪(诚实说)","invalidation":"【失效信号】什么价格/信号出现就必须离场(含具体价格)","confidenceReason":"信心等级的理由","risk":"最需警惕的风险与失效信号","confidence":"高/中/低"}。大盘弱只压仓位不否决方向：持仓若个股仍强(逆势强票/资金流入)可继续持有甚至回踩加仓，别因大盘弱就一律减仓；真正该减的是破位/主力出逃/明确利空。加仓/减仓类结论必须把 opQty+opAmount+newCost+expReturn+riskReward 都算出来，让用户能直接照做。只输出JSON。`;
  }
  if (mode === 'buy_advice') {
    return `【未持仓·买入决策请求】用户还没买这只票，正在研究到底要不要买。你要像贴身操盘顾问一样，**第一步先给一个明确结论(四选一)**，**第二步再按这个结论给出对应的差异化建议**，绝不能含糊，也不要不管结论如何都只会喊"买入"。
【买入结论四档(action 必须严格是其一)，按 共振分+现价位置+盈亏比+个股结构 判定】：
- **立即买入**：共振分≥4(或≥3且counterTrend逆势强票) + 现价不追高(posInDay≤60或缩量回踩企稳、贴买入带/支撑) + 盈亏比≥2:1 + 无明确利空。→ buyPrice/buyZone贴近现价可成交、stopPrice、targetPrice、positionNote(正常仓;弱市压到3~4成)。
- **回调再买**：看好(共振分≥3)但现价偏高/追高不划算(posInDay高/贴布林上轨/RSI偏高)。→ buyPrice/buyZone给"回踩到哪个价再买"(低于现价)、timing说清等什么信号、stopPrice、targetPrice。
- **小仓试错**：方向偏多但证据不够强(共振分=2，或逆势强票但大盘弱/资金未确认)——值得参与但不敢重仓。→ buyPrice/buyZone + 明确小仓 positionNote(如"仅1~2成试仓,破位就走") + 偏紧 stopPrice。**这是为弱市强票保留的档，别把本该小仓参与的机会也划到观望。**
- **观望**：证据不足或该回避——共振分≤1、或技术破位、或主力持续出逃(trend5连负)、或有明确利空、或盈亏比<1.8:1。→ buyPrice/buyZone可为null，必须给watchPrice(突破/跌破哪个价才重新评估)、timing说清等什么信号。
数据含：个股实时量价(nowPrice/dayHigh/dayLow/open/prevClose)、当日分时(intraday: now实时价/vwap均价/日内高低/posInDay位置/rhythm节奏/是否触及日内高低)、大盘情绪(market)、资金流向(marketFlow)、个股近20日走势(history: ma5/ma10/ma20、20日高低)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带上下轨/RSI/KDJ/MACD/支撑support压力resistance/买入带buyZone卖出带sellZone/止损stopLoss/止盈takeProfit)】${payload.account && payload.account.totalAssets ? `、账户全景 account(totalAssets总资产=${payload.account.totalAssets}元${payload.account.cash != null ? `、cash可用资金=${payload.account.cash}元` : ''}${payload.account.position != null ? `、position当前总仓位=${payload.account.position}%` : ''}${payload.account.holdMktValue != null ? `、holdMktValue当前持仓市值=${payload.account.holdMktValue}元` : ''})` : ''}${payload.quant ? '、量化模型 quant(score多因子分/bias/forecast走势预测)' : ''}。
数据：${data}${advisorData}

【决策逻辑，逐条结合数据，不许空谈】：
1. **先按四档规则对号入座**：读 resonance 共振分 + counterTrend(是否逆势强票) + posInDay(现价日内高低位) + 先算盈亏比，严格套用上面四档阈值。**不要因大盘弱就习惯性观望**——大盘弱体现在压低 positionNote 仓位，不改方向；逆势强票即使大盘弱也至少给"小仓试错"，别一律观望。振幅太小(recentAmplitude<2.5)且无逆势强票信号才归观望。
2. **买入时机(具体到信号+价位)**：用 intraday + tech 说清"现在这个点位该不该动、等什么信号"：现价在日内低位/贴支撑/RSI偏低/缩量回踩→可现价附近买；现价在日内高位/贴布林上轨/RSI超买/放量冲高→等回踩再买；无明确信号→观望等突破或回踩。把时机说成一句可执行的话(含具体价格)。
3. **价位(按结论给)**：立即买入/回调再买→给 buyPrice(优先贴近 tech.buyZone/布林下轨/支撑/MA10) + buyZone(便于分批) + stopPrice + targetPrice；观望→给 watchPrice(关键触发价)；不建议买→价位可全 null。价格必须贴合实时价、可成交，不能开虚价。
4. **账户全景约束(如果给了 account 必须执行)**：先用 account.cash 算这笔最多还能买几手(100股整数手)，再结合 marketEnv.suggestPosition 与当前总仓位/总资产决定建议先买几手。不要只说“1成仓”，而要换算成具体**买几手、约花多少钱、约占总资产/可用资金多少**。弱市默认首笔约总资产5%~10%，中性市约8%~15%，强市确认龙头约10%~20%；若现金不够则按最大可买整数手下调。${payload.quant ? `
5. **量化走势预测 quant.forecast**：upProb(未来5日上涨概率%)、direction(看涨/看跌/震荡)、targetLow~targetHigh(目标价区间)、expRet(预期涨跌%)。看涨且概率高(≥58)→倾向立即买入/回调买、买点可积极；看跌(≤42)→倾向观望或不建议买；震荡→回调再买、区间低吸。量化目标区间用来锚定 targetPrice。量化与技术面冲突时以稳健为先并点明分歧。` : ''}

请输出 JSON：{"action":"立即买入 或 回调再买 或 小仓试错 或 观望","tier":"now(立即买) 或 pullback(回调买) 或 probe(小仓试错) 或 wait(观望)","tone":"red(立即买/回调买) 或 gold(小仓试错) 或 muted(观望)","title":"一句话结论(直接对应action)","timing":"【买入时机·可直接照做】什么点位/信号出现再买或再评估，含具体价格数字","actionPlan":"【最重要·一句话可直接照做】结论+建议先买几手(若有account必须给整数手数)+约占总资产/可用资金比例+价位+触发条件揉成一句话，含具体价格数字","buyPrice":建议买入价数字或null,"buyZone":"买入区间(如 56.5~57.2)或null","watchPrice":"观望时的关键触发价(如:站上58.2再评估)或null","stopPrice":止损价数字或null,"targetPrice":目标价数字或null,"planQty":"建议首笔买入几手(整数;观望填0)","planAmount":"按建议买入约需资金(元,=买价×手数×100;观望填0)","planWeight":"按建议买入约占总资产/可用资金多少(如 总资产8% / 可用资金25%; 无account则给相对仓位)","reason":"大白话理由(为什么是这一档、价位为什么定在这，并解释为什么是这个手数/仓位)","techNote":"技术面依据(必须点名当前是否金叉/是否均线多头排列，并引用RSI/ATR/布林/支撑压力的具体数字)","fundNote":"资金面依据(引用mainNetYi/main5dYi/trend5/inflowDays，研判主力持续进货还是出货、值不值得跟)","newsNote":"消息面研判(引用newsHeadlines/newsDigest；有减持/问询/解禁等利空必须点明并据此降级；无则写'近期无明显利空')","macroNote":"宏观/国内外影响(引用macroNews判断风险偏好/避险,及对该股板块是顺风还是逆风;无则'宏观中性')","seatNote":"龙虎榜/席位(若lhb有数据，点明是否知名游资/机构在买smartMoney；无则写'近期未上榜')"${payload.quant ? ',"quantNote":"量化走势预测如何支撑(引用score/upProb/目标区间的具体数字，大白话)"' : ''},"riskReward":"盈亏比(目标空间÷止损空间，如 2.5:1)","positionNote":"必须是基于账户余额和总资产换算后的资金管理建议：说明这笔建议买入/不买对应几手、约用多少资金、占总资产/可用资金多少；不是只写抽象仓位。","resonanceScore":共振分数字(引用给定resonance.score,0-6),"bearCase":"【反方观点】我这个判断可能错在哪(一句话，诚实说)","invalidation":"【失效信号】什么价格/信号一出现就证明我错了、必须离场(含具体价格)","confidenceReason":"信心为什么是这个等级(结合共振分/消息面/大盘环境说明)","risk":"最需警惕的风险与不该买的情形","confidence":"高/中/低"}。结论与价位字段必须自洽(观望不硬给buyPrice)。【重要】四档里"小仓试错"是为弱市强票保留的——逆势强票(counterTrend.isStrong)或共振分=2且结构不坏，应给"小仓试错"而不是观望；共振分≥3给回调买或立即买。大盘弱只体现在压低仓位(positionNote)，不改方向。若给了 account，planQty/planAmount/planWeight 必须认真计算、不可空泛。只输出JSON。`;
  }
  if (mode === 'review') {
    const sess = payload.session === 'close' ? '收盘复盘' : payload.session === 'noon' ? '午盘复盘' : '复盘';
    const nextDay = payload.nextTradeDay || '下一交易日';   // 真实下一交易日(已跳过周末/节假日)
    const guideFor = payload.session === 'close'
      ? `这是**收盘后复盘**，用户看盘结束、准备为**${nextDay}**做决策。请站在"今天收完盘、${nextDay}该怎么办"的视角，给出对下一交易日开盘的明确指导（继续持有/${nextDay}开盘减/回踩再加/直接止损等）。注意：下一交易日是 ${nextDay}，不要笼统说"明天"，也不要把它当成周末。`
      : payload.session === 'noon'
      ? '这是**午间休市复盘**，上午已经交易完、下午还要开盘。请站在"上午收完、下午该怎么操作"的视角，给出对**今天下午**的明确指导（下午继续持有/逢高减/回踩加/盯住某价位等）。'
      : `这是用户手动发起的复盘，请对该股当前状态做一次完整复盘，并给出后续操作指导；涉及下一交易日时用"${nextDay}"表述。`;
    return `【持仓复盘请求·${sess}】用户${payload.hold ? '持有' : '关注'}这只票，需要你像操盘教练一样做一次**复盘总结**：回顾这只股当前的走势/量价/资金/量化状态，结合用户的持仓成本与今日/历史交易，给出一句话能照做的后续操作指导。${guideFor}
${payload.openTNet ? `【重要·持仓口径】hold(cost/qty) 已按【实时持仓】计算：用户有未结算做T腿，净${payload.openTNet > 0 ? '买入' : '卖出'}${Math.abs(payload.openTNet)}手在结算前【就当作已经${payload.openTNet > 0 ? '加仓' : '减仓'}】计入了当前持仓。请以这个实时持仓来复盘和给后续指导。` : ''}
数据含：个股实时量价、当日分时(intraday: vwap均价/日内高低/posInDay位置/rhythm节奏)、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history)、【个股历史规律画像 stockProfile】、【专业技术指标 tech】${payload.quant ? '、量化模型 quant(score/bias/forecast走势预测)' : ''}${payload.hold ? '、用户持仓 hold(cost成本/qty手数/pnlPct浮盈亏%)' : ''}${payload.todayTrades ? '、用户今日在该股的成交 todayTrades(买卖价/手数)' : ''}${payload.tradeHistory ? '、用户过往交易记录 tradeHistory' : ''}。
数据：${data}${advisorData}

【复盘逻辑，逐条结合数据】：
1. **今日表现回顾**：用当日涨跌/分时节奏(rhythm)/量比，一句话概括这只股今天走成什么样、强还是弱。
2. **持仓盈亏与操作检视**：${payload.hold ? '结合 hold.cost/pnlPct 说清此刻浮盈还是套牢、幅度多少；' : ''}${payload.todayTrades ? '点评今日 todayTrades 的买卖操作是否合理(追高了/抄早了/高抛得当等)，有则表扬、错则点出。' : '若无今日成交则跳过操作检视。'}
3. **趋势与位置研判**：用 history(均线多空/20日位置) + tech(布林/RSI/KDJ/支撑压力) + stockProfile 判断当前处于强势/转弱/超跌，配合量化 forecast 判断后市方向。
4. **给出下一步指导(最重要)**：${payload.session === 'close' ? '明确"明天开盘"怎么做' : payload.session === 'noon' ? '明确"今天下午"怎么做' : '明确后续怎么做'}——持有/加仓/减仓/清仓/止损，并给**具体参考价位**（回踩加仓价、反弹减仓价、止损价），让用户能直接照做。

请输出 JSON：{"stance":"持有 或 加仓 或 减仓 或 清仓 或 观望","tone":"red(偏多/持有/加仓) 或 green(偏空/减仓/清仓) 或 muted(中性观望)","headline":"一句话复盘结论(最醒目，含核心动作)","todayRecap":"今日走势与量价一句话回顾(引用涨跌/量比/节奏)","pnlNote":"${payload.hold ? '当前持仓盈亏一句话(引用成本与浮盈亏%)' : '未持仓，跳过'}","tradeReview":"${payload.todayTrades ? '今日操作点评(哪步做得好/该改进)' : '今日无成交'}","nextAction":"【${payload.session === 'noon' ? '今天下午' : (payload.nextTradeDay || '下一交易日')}怎么做·可直接照做】动作+手数+参考价位+触发条件揉成一句话，含具体价格与手数","opQty":"本次建议操作手数(加X手/减X手/持有0，整数)","opAmount":"本次操作约需资金或回笼资金(元,=价×手数×100，加仓为支出/减仓为回笼)","newCost":"若按建议加/减仓后的新持仓成本(数字或'不变')","expReturn":"预期收益(到目标价能赚多少元、约+N%;结合holdQty和目标价算)","riskAmount":"到止损会亏多少元(结合手数与止损价算)","riskReward":"盈亏比(预期收益空间÷止损空间，如 2.2:1)","posAfter":"${payload.account && payload.account.totalAssets ? '操作后该股占账户仓位%(用account.totalAssets算)' : '账户总资产未填,给相对仓位描述(如占比约X成)'}","addPrice":回踩加仓参考价数字或null,"reducePrice":反弹减仓参考价数字或null,"stopPrice":止损价数字或null,"targetPrice":目标价数字或null,"keyLevel":"要盯住的关键价位说明(如:守住X则持有，破X则走)","techNote":"技术面依据(点名是否金叉/多头排列 + RSI/支撑压力)","fundNote":"资金面依据(引用主力净流入/流出、5日主力、盘口委比，研判主力进出)","newsNote":"消息面(有利空点明,无则'无明显利空')","macroNote":"宏观/国内外影响(引用macroNews判断风险偏好/避险,及对该股板块是顺风还是逆风;无则'宏观中性')","seatNote":"龙虎榜/席位(有则点明smartMoney,无则'近期未上榜')"${payload.quant ? ',"quantNote":"量化走势预测一句话(引用upProb/direction/目标区间)"' : ''},"resonanceScore":共振分数字(引用resonance.score),"bearCase":"【反方观点】这个复盘判断可能错在哪","invalidation":"【失效信号】${payload.session === 'noon' ? '下午' : (payload.nextTradeDay || '下一交易日')}什么价一破就改变计划(含价格)","risk":"最需警惕的风险","confidence":"高/中/低"}。大盘弱只压仓位不否决方向；个股强则可持有/加仓。涉及下一交易日时用给定的真实日期表述，不要说成"明天"当成周末。加仓/减仓类结论必须给 opQty+opAmount+expReturn+riskReward，把账算清楚让用户能直接照做。只输出JSON。`;
  }
  return `分析以下数据并输出JSON：${data}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(200).send(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const BASE = process.env.LLM_BASE_URL;
  const KEY = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'DeepSeek-V3.2-Pro';
  // 顶级操盘军师专用模型：深度个股研判(做T/加减仓/买入/复盘)用更强、更快、原生JSON稳定的模型
  const ADVISOR_MODEL = process.env.ADVISOR_MODEL || 'DeepSeek-V4-Pro';
  if (!BASE || !KEY) {
    return res.status(200).send(JSON.stringify({ ok: false, error: 'LLM 未配置' }));
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const mode = (body && body.mode) || 'market';
    const payload = (body && body.payload) || {};

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
    if ((mode === 't_advice' || mode === 'plan' || mode === 'price' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') && payload.code) {
      try {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = `${proto}://${host}`;
        const getJ = (p) => fetch(origin + p).then((r) => r.json()).catch(() => null);

        const [mkt, sec, detail, trend, stockFund, lhb, corpus, macroNews, todayQ] = await Promise.all([
          getJ('/api/market'),
          getJ('/api/sectors?type=industry&sort=main'),
          getJ(`/api/stock_detail?code=${payload.code}&klt=101&lmt=60`),
          fetchTrend(payload.code),
          fetchStockFund(payload.code),
          fetchStockLHB(payload.code),
          buildCorpus(payload.code).catch(() => null),  // 消息面/公告/基本面 RAG 语料
          fetchMacroNews(),                              // 国内外宏观/重大事件
          getJ(`/api/quote?codes=${payload.code}&_t=${Date.now()}`),  // ★今日实时行情(涨跌幅/涨停/量比)——纠正"技术面/资金是昨日口径"的滞后
        ]);
        // ★今日实时行情：这是"当下事实"，优先级高于昨日收盘的 tech/资金
        {
          const q0 = todayQ && todayQ.list && todayQ.list[0];
          if (q0 && q0.price != null) {
            payload.todayQuote = {
              price: q0.price, pct: q0.pct,
              isLimitUp: !!q0.isLimitUp, isLimitDown: !!q0.isLimitDown,
              high: q0.high, low: q0.low, open: q0.open, prevClose: q0.prevClose,
              turnover: q0.turnover, volRatio: q0.volRatio,
              bigMove: q0.pct != null && Math.abs(q0.pct) >= 7,  // 当日大涨/大跌(>7%)
            };
          }
        }
        if (macroNews && macroNews.length) payload.macroNews = macroNews.map((n) => n.title).slice(0, 6);
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
        if (lhb) payload.lhb = lhb;
        // 信号回测：用历史K线检验该股"金叉后上涨"的命中率，给预测一个可信度自评
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length >= 40) {
          try { const bt = backtestSignal(detail.candles, 5); if (bt) payload.backtest = bt; } catch { /* ignore */ }
        }
        // 量化预测：用刚取到的 K线喂给量化服务（绕开其取数被风控），t_advice/price 场景带持仓成本
        let quant = null;
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length >= 25) {
          const hold = payload.holdCost ? { cost: payload.holdCost, qty: payload.holdQty } : null;
          try { quant = await fetchQuantPredict(payload.code, detail.candles, hold, 7000); } catch { /* 静默 */ }
        }

        // 大盘情绪
        if (mkt && mkt.ok) {
          const b = mkt.breadth || {};
          payload.market = {
            indices: (mkt.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
            up: b.up, down: b.down, limitUp: b.limitUp, limitDown: b.limitDown,
            upDownRatio: b.down ? +(b.up / b.down).toFixed(2) : null,
          };
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
          if (mode === 't_advice' || mode === 'price' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') {
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
            reads: quant.reads, asOf: quant.asOf,
          };
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
        // 综合可信度(0~100)：共振(50%) + 回测命中率(25%) + 大盘环境(15%) + 消息面无雷(10%)
        {
          const rez = payload.resonance ? payload.resonance.score / (payload.resonance.max || 6) : 0.4;
          const bt = payload.backtest && payload.backtest.hitRate != null ? payload.backtest.hitRate / 100 : 0.5;
          const env = payload.marketEnv ? payload.marketEnv.score / 100 : 0.5;
          const news = (payload.resonance && payload.resonance.hasNegNews) ? 0.2 : 0.9;
          let conf = Math.round((rez * 0.5 + bt * 0.25 + env * 0.15 + news * 0.10) * 100);
          conf = Math.min(95, Math.max(15, conf)); // 永远不给100%,也不低于15
          let band = conf >= 68 ? '较可信' : conf >= 48 ? '中等' : '低(仅参考)';
          payload.trustScore = { score: conf, band, note: '综合共振/历史命中率/大盘环境/消息面得出，非胜率承诺' };
        }
        // 风格
        payload.style = payload.style || 'balanced'
      } catch (e) {
        // 补数据失败不阻断
      }
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 44000);

    const isAdvisor = (mode === 't_advice' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review' || mode === 'price' || mode === 'plan');
    const useModel = isAdvisor ? ADVISOR_MODEL : MODEL;
    const sysPrompt = isAdvisor ? ADVISOR_SYSTEM : SYSTEM_PROMPT;

    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: buildUserPrompt(mode, payload, ragText) },
        ],
        temperature: 0.4,
        max_tokens: (mode === 'scan' || mode === 'daily' || mode === 'scan_pick') ? 2200 : (mode === 't_advice' ? 2000 : (mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') ? 1900 : 1200),
        response_format: { type: 'json_object' },
      }),
    });
    clearTimeout(t);

    if (!resp.ok) {
      const errText = await resp.text();
      return res
        .status(200)
        .send(JSON.stringify({ ok: false, error: `LLM ${resp.status}`, detail: errText.slice(0, 200) }));
    }

    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content || '';

    // 解析模型返回的 JSON（容错：剥离可能的 ```json 包裹）
    let result;
    try {
      const cleaned = content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      result = JSON.parse(cleaned);
    } catch {
      result = { raw: content };
    }

    res.status(200).send(
      JSON.stringify({
        ok: true,
        mode,
        model: useModel,
        updatedAt: Date.now(),
        result,
        news: newsRefs,
        // 可信度元信息：供前端展示共振灯/环境/龙虎榜/消息面(不依赖模型自报)
        meta: {
          resonance: payload.resonance || null,
          counterTrend: payload.counterTrend || null,
          trustScore: payload.trustScore || null,
          marketEnv: payload.marketEnv || null,
          backtest: payload.backtest || null,
          lhb: payload.lhb ? { onList: true, date: payload.lhb.date, times30d: payload.lhb.times30d, smartMoney: payload.lhb.smartMoney, smartSeats: payload.lhb.smartSeats, buySeats: payload.lhb.buySeats } : null,
          hasNegNews: payload.resonance ? payload.resonance.hasNegNews : null,
          newsHeadlines: payload.newsHeadlines || null,
          macroNews: payload.macroNews || null,
          fundAsOf: payload.stockFund ? { date: payload.stockFund.asOfDate, historical: payload.stockFund.isHistorical, main5dAvg: payload.stockFund.main5dAvgYi, inflowDays: payload.stockFund.inflowDays } : null,
          marketPhase: payload.marketPhase || null,
          todayQuote: payload.todayQuote || null,
        },
        usedRag: !!ragText,
        usage: j.usage || null,
      })
    );
  } catch (e) {
    res.status(200).send(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}
