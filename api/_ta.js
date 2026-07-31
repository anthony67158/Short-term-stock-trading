// ============================================================
// 专业技术指标引擎（共享模块，前后端一致；下划线开头不占 Vercel 函数位）
// 输入：candles = [{date,open,close,high,low,volume,pct}]（按时间升序，最后一根最新）
// 输出：既有“专业指标数值”，又有“大白话结论”，并直接给出对买卖有用的价位锚点
// 说明：全部为本地统计口径，非投资建议
// ============================================================

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); }
function round(v, d = 2) { return v == null || isNaN(v) ? null : +Number(v).toFixed(d); }

// 简单移动均线（末端第 n 日）
function sma(closes, n) {
  if (closes.length < n) return null;
  return avg(closes.slice(-n));
}
// EMA 序列
function emaSeries(arr, n) {
  if (!arr.length) return [];
  const k = 2 / (n + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

// ---- ATR 真实波幅（定价核心：衡量“这只股一天正常波动几块钱”）----
// TR = max(高-低, |高-昨收|, |低-昨收|)；ATR = TR 的 N 日均值
function computeATR(candles, n = 14) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  const atr = avg(trs.slice(-n));
  const last = candles[candles.length - 1].close;
  return { atr: round(atr, 3), atrPct: last ? round((atr / last) * 100, 2) : null };
}

// ---- 布林带（买卖区间：下轨=低吸区，上轨=高抛区）----
function computeBoll(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const seg = closes.slice(-n);
  const mid = avg(seg), dev = sd(seg);
  const upper = mid + k * dev, lower = mid - k * dev;
  const last = closes[closes.length - 1];
  const width = mid ? ((upper - lower) / mid) * 100 : null; // 带宽%（越小越可能变盘）
  const pctB = upper > lower ? ((last - lower) / (upper - lower)) * 100 : 50; // 现价在带内位置%
  return { upper: round(upper), mid: round(mid), lower: round(lower), width: round(width), pctB: round(pctB, 0) };
}

// ---- RSI 相对强弱（超买>70该抛，超卖<30可吸）----
function computeRSI(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  const rs = loss === 0 ? 100 : gain / loss;
  return round(loss === 0 ? 100 : 100 - 100 / (1 + rs), 1);
}

// ---- MACD（趋势动能；金叉偏多、死叉偏空）----
function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaF = emaSeries(closes, fast), emaS = emaSeries(closes, slow);
  const dif = closes.map((_, i) => emaF[i] - emaS[i]);
  const dea = emaSeries(dif, signal);
  const macd = (dif[dif.length - 1] - dea[dea.length - 1]) * 2;
  const difNow = dif[dif.length - 1], deaNow = dea[dea.length - 1];
  const difPrev = dif[dif.length - 2], deaPrev = dea[dea.length - 2];
  let cross = null;
  if (difPrev <= deaPrev && difNow > deaNow) cross = 'gold';
  else if (difPrev >= deaPrev && difNow < deaNow) cross = 'dead';
  return { dif: round(difNow, 3), dea: round(deaNow, 3), macd: round(macd, 3), cross };
}

// ---- KDJ（短线择时；J<0 或 K<20 超卖、J>100 或 K>80 超买）----
function computeKDJ(candles, n = 9) {
  if (candles.length < n) return null;
  let k = 50, d = 50;
  for (let i = n - 1; i < candles.length; i++) {
    const seg = candles.slice(i - n + 1, i + 1);
    const hi = Math.max(...seg.map((c) => c.high));
    const lo = Math.min(...seg.map((c) => c.low));
    const rsv = hi > lo ? ((candles[i].close - lo) / (hi - lo)) * 100 : 50;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }
  const j = 3 * k - 2 * d;
  return { k: round(k, 1), d: round(d, 1), j: round(j, 1) };
}

// ---- 近期支撑/压力位（近 N 日高低点 + 整数关口，给具体买卖锚）----
function computeSR(candles, n = 20) {
  const seg = candles.slice(-n);
  if (!seg.length) return null;
  const hi = Math.max(...seg.map((c) => c.high));
  const lo = Math.min(...seg.map((c) => c.low));
  return { resistance: round(hi), support: round(lo) };
}

// ============================================================
// 主函数：产出“专业指标 + 大白话 + 买卖价位建议”
// ============================================================
export function computeTechnicals(candles, periodLabel = '日') {
  const cs = (candles || []).filter((c) => c && c.close != null && c.high != null && c.low != null);
  if (cs.length < 15) return null;
  const closes = cs.map((c) => c.close);
  const last = closes[closes.length - 1];

  const ma = { ma5: sma(closes, 5), ma10: sma(closes, 10), ma20: sma(closes, 20), ma60: sma(closes, 60) };
  // 均线金叉/死叉（MA5 上穿/下穿 MA10）——短线最常用的择时信号
  let maCross = null;
  if (closes.length >= 11) {
    const ma5Prev = sma(closes.slice(0, -1), 5), ma10Prev = sma(closes.slice(0, -1), 10);
    if (ma.ma5 != null && ma.ma10 != null && ma5Prev != null && ma10Prev != null) {
      if (ma5Prev <= ma10Prev && ma.ma5 > ma.ma10) maCross = 'gold';       // 金叉
      else if (ma5Prev >= ma10Prev && ma.ma5 < ma.ma10) maCross = 'dead';  // 死叉
    }
  }
  // 均线排列：多头(5>10>20>60) / 空头(5<10<20<60) / 缠绕
  let maTrend = 'tangle';
  const { ma5, ma10, ma20, ma60 } = ma;
  if (ma5 != null && ma10 != null && ma20 != null) {
    const m60 = ma60 != null ? ma60 : -Infinity;
    if (ma5 > ma10 && ma10 > ma20 && ma20 >= (ma60 != null ? ma60 : ma20)) maTrend = 'bull';
    else if (ma5 < ma10 && ma10 < ma20 && (ma60 == null || ma20 <= ma60)) maTrend = 'bear';
  }
  const atrObj = computeATR(cs, 14);
  const boll = computeBoll(closes, 20, 2);
  const rsi = computeRSI(closes, 14);
  const macd = computeMACD(closes, 12, 26, 9);
  const kdj = computeKDJ(cs, 9);
  const sr = computeSR(cs, 20);
  const vols = cs.map((c) => c.volume || 0);
  const volRatio = vols.length >= 6 ? round(vols[vols.length - 1] / (avg(vols.slice(-6, -1)) || 1), 2) : null;

  // ---------- 大白话解读（每条：指标 → 人话 → 对买卖的含义）----------
  const reads = [];
  // ATR
  if (atrObj && atrObj.atr != null) {
    reads.push({
      key: 'ATR', tag: '日均波动', tone: 'muted',
      value: `${atrObj.atr} 元 (${atrObj.atrPct}%)`,
      plain: `这只股一天正常上下波动约 ${atrObj.atr} 元。做T挂单、设止损止盈的“距离”就参考它——比如止损设在买入价下方约 1.5 个波幅（≈${round(atrObj.atr * 1.5, 2)} 元）比较合理，太近容易被洗、太远亏太多。`,
    });
  }
  // 布林带
  if (boll) {
    let tone = 'muted', plain = '';
    if (boll.pctB >= 85) { tone = 'green'; plain = `现价贴近布林上轨（${boll.upper}），处于高位区，短线偏贵，适合高抛/减仓，不宜追高。`; }
    else if (boll.pctB <= 15) { tone = 'red'; plain = `现价贴近布林下轨（${boll.lower}），处于低位区，短线偏便宜，是低吸的相对安全区。`; }
    else plain = `现价在布林带中部（位置 ${boll.pctB}%），上有压力 ${boll.upper}、下有支撑 ${boll.lower}，区间内高抛低吸。`;
    reads.push({ key: 'BOLL', tag: '布林带', tone, value: `下轨 ${boll.lower} / 中 ${boll.mid} / 上轨 ${boll.upper}`, plain });
    if (boll.width != null && boll.width <= 6) reads.push({ key: 'BOLL_W', tag: '带口收窄', tone: 'muted', value: `带宽 ${boll.width}%`, plain: `布林带口收得很窄，波动被压缩，往往是变盘前兆——突破哪个方向就大概率往哪走，可等方向明确再动手。` });
  }
  // RSI
  if (rsi != null) {
    let tone = 'muted', plain = '';
    if (rsi >= 70) { tone = 'green'; plain = `RSI=${rsi}，进入超买区（>70），短线涨过头了，容易回调，手里有货可考虑高抛，别追。`; }
    else if (rsi <= 30) { tone = 'red'; plain = `RSI=${rsi}，进入超卖区（<30），短线跌过头了，随时可能反弹，可留意低吸机会。`; }
    else plain = `RSI=${rsi}，处于中性区（30~70），多空相对均衡，没有明显超买超卖。`;
    reads.push({ key: 'RSI', tag: 'RSI强弱', tone, value: String(rsi), plain });
  }
  // KDJ
  if (kdj) {
    let tone = 'muted', plain = `KDJ：K ${kdj.k} / D ${kdj.d} / J ${kdj.j}。`;
    if (kdj.j <= 0 || kdj.k <= 20) { tone = 'red'; plain += ' 处于超卖，短线有反弹动能，偏低吸。'; }
    else if (kdj.j >= 100 || kdj.k >= 80) { tone = 'green'; plain += ' 处于超买，短线有回落风险，偏高抛。'; }
    else plain += ' 中性区间，跟随趋势即可。';
    reads.push({ key: 'KDJ', tag: 'KDJ择时', tone, value: `J ${kdj.j}`, plain });
  }
  // MACD
  if (macd) {
    let tone = 'muted', plain = `MACD：DIF ${macd.dif} / DEA ${macd.dea} / 柱 ${macd.macd}。`;
    if (macd.cross === 'gold') { tone = 'red'; plain += ' 刚出现金叉，趋势动能转多，偏多操作。'; }
    else if (macd.cross === 'dead') { tone = 'green'; plain += ' 刚出现死叉，趋势动能转空，注意减仓。'; }
    else if (macd.macd > 0) { tone = 'red'; plain += ' 红柱运行，动能偏多。'; }
    else { tone = 'green'; plain += ' 绿柱运行，动能偏空。'; }
    reads.push({ key: 'MACD', tag: 'MACD动能', tone, value: macd.cross === 'gold' ? '金叉' : macd.cross === 'dead' ? '死叉' : (macd.macd > 0 ? '红柱' : '绿柱'), plain });
  }
  // 量能
  if (volRatio != null) {
    let tone = 'muted', plain = '';
    if (volRatio >= 2) { tone = 'red'; plain = `今日成交是近5日均量的 ${volRatio} 倍，明显放量，若配合上涨说明资金进场、突破更可信；若放量下跌则要警惕出货。`; }
    else if (volRatio <= 0.6) { tone = 'muted'; plain = `今日缩量至近5日均量的 ${volRatio} 倍，观望情绪浓，缩量回踩支撑往往是较安全的低吸点。`; }
    else plain = `量能温和（近5日均量的 ${volRatio} 倍），无异常放巨量或极度缩量。`;
    reads.push({ key: 'VOL', tag: '量能', tone, value: `${volRatio}×`, plain });
  }

  // ---------- 买卖价位建议（多指标共振，给具体数字）----------
  // 买入参考带：布林下轨 / MA20 / 近20日支撑 里取“不低于现价太多的最近支撑”，并用 ATR 给缓冲
  const supports = [boll && boll.lower, ma.ma20, sr && sr.support].filter((x) => x != null);
  const resistances = [boll && boll.upper, sr && sr.resistance].filter((x) => x != null);
  const atr = atrObj ? atrObj.atr : null;
  const buyZone = supports.length ? {
    low: round(Math.min(...supports)),
    high: round(Math.max(...supports.filter((s) => s <= last * 1.02))) || round(Math.min(...supports)),
  } : null;
  const sellZone = resistances.length ? {
    low: round(Math.min(...resistances.filter((r) => r >= last * 0.98))) || round(Math.max(...resistances)),
    high: round(Math.max(...resistances)),
  } : null;
  const stopLoss = (atr != null && last) ? round(last - 1.5 * atr) : (buyZone ? round(buyZone.low * 0.97) : null); // 止损：现价下方1.5ATR
  const takeProfit = (atr != null && last) ? round(last + 2 * atr) : (sellZone ? sellZone.high : null);            // 止盈：现价上方2ATR

  // ---------- 综合结论（一句话该买该卖还是观望）----------
  let bull = 0, bear = 0;
  if (boll) { if (boll.pctB <= 15) bull++; if (boll.pctB >= 85) bear++; }
  if (rsi != null) { if (rsi <= 30) bull++; if (rsi >= 70) bear++; }
  if (kdj) { if (kdj.j <= 0 || kdj.k <= 20) bull++; if (kdj.j >= 100 || kdj.k >= 80) bear++; }
  if (macd) { if (macd.cross === 'gold' || macd.macd > 0) bull++; if (macd.cross === 'dead' || macd.macd < 0) bear++; }
  if (ma.ma20 != null) { if (last >= ma.ma20) bull++; else bear++; }
  if (maCross === 'gold') bull++; else if (maCross === 'dead') bear++;
  if (maTrend === 'bull') bull++; else if (maTrend === 'bear') bear++;
  let verdict, vtone;
  if (bull - bear >= 2) { verdict = '偏多：多项指标共振向上，逢低吸纳为主'; vtone = 'red'; }
  else if (bear - bull >= 2) { verdict = '偏空：多项指标转弱，逢高减仓为主'; vtone = 'green'; }
  else { verdict = '中性：多空信号交织，区间高抛低吸、别追涨杀跌'; vtone = 'muted'; }

  return {
    price: round(last),
    ma: { ma5: round(ma.ma5), ma10: round(ma.ma10), ma20: round(ma.ma20), ma60: round(ma.ma60) },
    maCross, maTrend,
    atr: atrObj, boll, rsi, macd, kdj, sr, volRatio,
    reads,                       // 大白话逐条解读
    verdict, vtone, bull, bear,  // 综合结论
    priceHints: { buyZone, sellZone, stopLoss, takeProfit }, // 给定价用的价位锚
  };
}

// 信号滚动回测：用历史K线检验"金叉/多头后N日上涨"的命中率，给预测一个"这只股历史上准不准"的自评
// candles 升序[{open,close,high,low}]；返回 {hitRate, samples, note} 或 null
export function backtestSignal(candles, horizon = 5) {
  const cs = (candles || []).filter((c) => c && c.close != null);
  if (cs.length < 40) return null;
  const closes = cs.map((c) => c.close);
  const sma = (arr, n, end) => { if (end < n - 1) return null; let s = 0; for (let i = end - n + 1; i <= end; i++) s += arr[i]; return s / n; };
  let signals = 0, hits = 0;
  // 遍历历史，每次出现"MA5上穿MA10金叉"时，看未来 horizon 日收盘是否上涨
  for (let i = 11; i < cs.length - horizon; i++) {
    const ma5 = sma(closes, 5, i), ma10 = sma(closes, 10, i);
    const ma5p = sma(closes, 5, i - 1), ma10p = sma(closes, 10, i - 1);
    if (ma5 == null || ma10 == null || ma5p == null || ma10p == null) continue;
    const goldCross = ma5p <= ma10p && ma5 > ma10;
    if (!goldCross) continue;
    signals++;
    const fut = closes[i + horizon];
    if (fut > closes[i]) hits++;
  }
  if (signals < 3) return { hitRate: null, samples: signals, note: `历史金叉样本不足(${signals}次)，命中率不可靠` };
  const hitRate = Math.round((hits / signals) * 100);
  let note;
  if (hitRate >= 60) note = `历史上该股金叉后${horizon}日上涨命中率${hitRate}%(${signals}次样本)，信号较可靠`;
  else if (hitRate >= 45) note = `历史金叉后命中率${hitRate}%(${signals}次)，一般，需结合其他信号`;
  else note = `历史金叉后命中率仅${hitRate}%(${signals}次)，该股金叉信号不灵，别只凭技术面追`;
  return { hitRate, samples: signals, horizon, note };
}

// 供 AI prompt 用的“紧凑摘要”（省 token，只保留结论性数据）
export function techSummaryForAI(tech) {
  if (!tech) return null;
  const p = tech.priceHints || {};
  return {
    verdict: tech.verdict, bull: tech.bull, bear: tech.bear,
    ma: tech.ma,
    maCross: tech.maCross === 'gold' ? 'MA5上穿MA10金叉' : tech.maCross === 'dead' ? 'MA5下穿MA10死叉' : '无均线交叉',
    maTrend: tech.maTrend === 'bull' ? '均线多头排列(5>10>20>60)' : tech.maTrend === 'bear' ? '均线空头排列(5<10<20<60)' : '均线缠绕',
    atr: tech.atr && tech.atr.atr, atrPct: tech.atr && tech.atr.atrPct,
    boll: tech.boll && { lower: tech.boll.lower, mid: tech.boll.mid, upper: tech.boll.upper, pctB: tech.boll.pctB, width: tech.boll.width },
    rsi: tech.rsi, kdj: tech.kdj && tech.kdj.j, macd: tech.macd && (tech.macd.cross === 'gold' ? 'MACD金叉' : tech.macd.cross === 'dead' ? 'MACD死叉' : (tech.macd.macd > 0 ? 'MACD红柱' : 'MACD绿柱')),
    volRatio: tech.volRatio,
    support: tech.sr && tech.sr.support, resistance: tech.sr && tech.sr.resistance,
    buyZone: p.buyZone, sellZone: p.sellZone, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
  };
}

// ============ 量化预测微服务调用（CloudBase）============
// 数据由本地传入（candles），服务端只做因子打分+走势预测，绕开其自身取数被风控的问题。
// 仅当配置了环境变量 QUANT_URL 才调用；失败静默返回 null，绝不阻断主流程。
// candles: [{date,open,close,high,low,volume}]（升序）；hold: {cost,qty} 可选（持仓则给加/减建议）
export async function fetchQuantPredict(code, candles, hold, timeoutMs = 8000) {
  const base = process.env.QUANT_URL;
  const key = process.env.QUANT_KEY || '';
  if (!base) return null;
  const cs = (candles || []).filter((c) => c && c.close != null && c.high != null && c.low != null)
    .slice(-120)
    .map((c) => ({ date: c.date, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }));
  if (cs.length < 25) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${base.replace(/\/$/, '')}/predict`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      body: JSON.stringify({ code, candles: cs, hold: hold || null }),
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.ok) ? j : null;
  } catch { return null; }
}

