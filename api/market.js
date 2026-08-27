import { emGet, sendJson, sendError, num } from './_lib.js';
import { fetchMarketFlashes, fetchNews } from './_market_data.js';
import { fetchLimitPool } from './_limit_pool.js';

// 盘面研究·外部宏观快讯聚合（合并入 market 端点以规避 Hobby 12 函数上限）
// GET /api/market?news=1 → { ok, macro:[{title,date,url}], flashes:[{title,src,date,url,level}] }
// 数据源：金十/财联社系/东财聚合 + 新浪7×24 + 华尔街见闻 + 东财/见闻定向检索。
async function handleNews(res) {
  try {
    const [flashPool, macro] = await Promise.all([
      fetchMarketFlashes(30).catch(() => []),
      fetchNews('宏观 政策 央行 A股 美联储 关税 市场', 10).catch(() => []),
    ]);
    const flashes = (flashPool || [])
      .map((n) => ({ title: n.title, src: n.src || '快讯', date: n.date || '', url: n.url || '', level: n.level }))
      .slice(0, 30);
    let macroList = (macro || [])
      .map((n) => ({ title: n.title, date: n.date || '', url: n.url || '' }))
      .filter((n) => n.title)
      .slice(0, 10);
    // 兜底:东财搜索在服务端 egress IP 上偶发限流/超时→macro 为空。此时改用已抓到的
    // 财联社系/金十/新浪7×24快讯,挑出带宏观/政策/央行/海外关键词的条目当"宏观要闻",
    // 与 AI 侧 fetchMacroNews 的降级逻辑保持一致,确保面板不再出现"暂无"。
    if (!macroList.length) {
      const MACRO_RE = /(央行|货币|政策|降准|降息|LPR|财政|关税|美股|美联储|加息|经济|GDP|CPI|PPI|地缘|大盘|A股|外资|人民币|国常会|会议|监管|出口|贸易|指数)/;
      const pool = (flashPool || []).filter((x) => x && x.title);
      let cand = pool.filter((x) => MACRO_RE.test(x.title));
      if (!cand.length) cand = pool; // 关键词一条没命中→退化为最新快讯,总比空缺强
      const seen2 = new Set();
      macroList = cand
        .filter((x) => { const k = x.title.slice(0, 24); if (seen2.has(k)) return false; seen2.add(k); return true; })
        .map((x) => ({ title: (x.src ? `[${x.src}]${x.title}` : x.title).slice(0, 120), date: x.date || '', url: x.url || '' }))
        .slice(0, 10);
    }
    sendJson(res, { ok: true, macro: macroList, flashes, updatedAt: Date.now() }, { cache: 60 });
  } catch (e) {
    sendJson(res, { ok: false, error: String(e.message || e), macro: [], flashes: [] }, { cache: 0 });
  }
}

export function summarizeMarketBreadth(indexRows = [], limits = {}) {
  const primaryCodes = new Set(['000001', '399001', '899050'])
  const primary = (indexRows || []).filter((row) => primaryCodes.has(String(row?.f12 || '')))
  const complete = primary.length === primaryCodes.size && primary.every((row) =>
    [row?.f104, row?.f105, row?.f106].every((value) => Number.isFinite(Number(value)))
  )
  const sum = (field) => complete
    ? primary.reduce((total, row) => total + Math.max(0, Number(row[field]) || 0), 0)
    : null
  const up = sum('f104')
  const down = sum('f105')
  const flat = sum('f106')
  const limitUp = Number.isFinite(Number(limits.limitUp))
    ? Number(limits.limitUp)
    : null
  const limitDown = Number.isFinite(Number(limits.limitDown))
    ? Number(limits.limitDown)
    : null
  return {
    up,
    down,
    flat,
    limitUp,
    limitDown,
    total: complete ? up + down + flat : null,
    complete,
  }
}

function poolTotal(pool) {
  const total = Number(pool?.total)
  return Number.isFinite(total) && total >= 0 ? total : null
}

export function summarizeMarketSentiment({
  limitUpPool = null,
  limitDownPool = null,
  brokenLimitPool = null,
} = {}) {
  const limitUp = poolTotal(limitUpPool)
  const limitDown = poolTotal(limitDownPool)
  const brokenLimit = poolTotal(brokenLimitPool)
  const denominator = limitUp != null && brokenLimit != null
    ? limitUp + brokenLimit
    : 0
  const breakRatePct = denominator > 0
    ? +(brokenLimit / denominator * 100).toFixed(1)
    : null
  const limitUpList = Array.isArray(limitUpPool?.list)
    ? limitUpPool.list
    : []
  const boardHeights = limitUpList
    .map((item) => Number(item?.lbc || item?.boardCount || 1))
    .filter((value) => Number.isFinite(value) && value > 0)
  const maxBoardHeight = boardHeights.length
    ? Math.max(...boardHeights)
    : null
  const linkedBoardCount = boardHeights
    .filter((value) => value >= 2)
    .length

  let score = 50
  if (limitUp != null) {
    if (limitUp >= 60) score += 15
    else if (limitUp >= 30) score += 8
    else if (limitUp < 15) score -= 12
  }
  if (breakRatePct != null) {
    if (breakRatePct <= 15) score += 12
    else if (breakRatePct > 40) score -= 18
    else if (breakRatePct >= 35) score -= 12
  }
  if (maxBoardHeight >= 5) score += 10
  else if (maxBoardHeight >= 3) score += 5
  if (limitDown > 10) score -= 10
  score = Math.max(0, Math.min(100, Math.round(score)))

  const hardRiskSignals = []
  if (breakRatePct > 40) {
    hardRiskSignals.push(`炸板率${breakRatePct}%超过40%`)
  }
  if (
    limitDown >= 20
    && limitUp != null
    && limitDown >= limitUp * 0.5
  ) {
    hardRiskSignals.push(`跌停${limitDown}家且亏钱效应扩散`)
  }
  const availableCount = [
    limitUp,
    limitDown,
    brokenLimit,
  ].filter((value) => value != null).length
  const phase = availableCount === 0
    ? 'UNKNOWN'
    : hardRiskSignals.length
      ? 'RETREAT'
      : score >= 75 && maxBoardHeight >= 5
        ? 'CLIMAX'
        : score >= 60
          ? 'EXPANSION'
          : score >= 45 ? 'RECOVERY' : 'ICE'
  const phaseLabel = {
    ICE: '冰点',
    RECOVERY: '修复',
    EXPANSION: '发酵',
    CLIMAX: '高潮',
    RETREAT: '退潮',
    UNKNOWN: '数据不足',
  }[phase]
  return {
    phase,
    phaseLabel,
    score,
    limitUp,
    limitDown,
    brokenLimit,
    breakRatePct,
    maxBoardHeight,
    linkedBoardCount,
    hardRiskSignals,
    dataQuality: availableCount === 3
      ? 'COMPLETE'
      : availableCount > 0 ? 'PARTIAL' : 'MISSING',
  }
}

function volumeComparisonContext(tradeDate, now = Date.now()) {
  const normalizedTradeDate = String(tradeDate || '').replaceAll('-', '')
  if (!/^\d{8}$/.test(normalizedTradeDate)) {
    return { comparable: false, tradeDate: null }
  }
  const date = new Date(now + 8 * 3600000)
  const today = `${date.getUTCFullYear()}${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return {
    comparable:
      normalizedTradeDate < today
      || normalizedTradeDate === today && minutes >= 14 * 60 + 50,
    tradeDate: normalizedTradeDate,
  }
}

export async function fetchMarketSnapshot() {
  const idxSecids = '1.000001,0.399001,0.399006,0.899050';
  const idxFields = 'f2,f3,f4,f12,f14,f6,f104,f105,f106';
  const idxPath =
    `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${encodeURIComponent(idxSecids)}` +
    `&fields=${idxFields}`;

  // 涨跌停必须用真实池；统一涨跌幅阈值会误判创业板和科创板。
  const [idxJson, ztPool, dtPool, zbPool, shK, szK] = await Promise.all([
    emGet(idxPath).catch(() => null),
    fetchLimitPool('zt').catch(() => null),
    fetchLimitPool('dt').catch(() => null),
    fetchLimitPool('zb').catch(() => null),
    emGet(`/api/qt/stock/kline/get?secid=1.000001&fields1=f1&fields2=f51,f57&klt=101&fqt=1&end=20500101&lmt=6`, { his: true }).catch(() => null),
    emGet(`/api/qt/stock/kline/get?secid=0.399001&fields1=f1&fields2=f51,f57&klt=101&fqt=1&end=20500101&lmt=6`, { his: true }).catch(() => null),
  ]);

  const indexRows = (idxJson && idxJson.data && idxJson.data.diff) || [];
  const indices = indexRows.map((d) => ({
    code: d.f12,
    name: d.f14,
    price: num(d.f2),
    pct: num(d.f3),
    chg: num(d.f4),
    amount: num(d.f6),
  }));

  const marketBreadth = summarizeMarketBreadth(
    indexRows,
    {
      limitUp: ztPool?.total,
      limitDown: dtPool?.total,
    },
  );
  // 指数成交额只取上证+深证，创业板已包含在深市内，北证单列不混入两市口径。
  const indexAmount = indices
    .filter((item) => item.code === '000001' || item.code === '399001')
    .reduce((total, item) => total + (Number(item.amount) || 0), 0);
  const indexAmountYi = indexAmount > 0
    ? +(indexAmount / 1e8).toFixed(0)
    : null;

  // 两市成交额 + 近5日均量对比，盘中调用方必须标明这是累计值。
  const klAmt = (kJson) => {
    const kl = (kJson && kJson.data && kJson.data.klines) || [];
    return kl.map((s) => {
      const parts = String(s).split(',');
      return {
        date: parts[0] || '',
        amount: +parts[1] || 0,
      };
    });
  };
  const shAmts = klAmt(shK), szAmts = klAmt(szK);
  let marketAmountYi = indexAmountYi, volVsAvg5 = null, volLevel = null;
  let volumeComparison = { comparable: false, tradeDate: null };
  if (shAmts.length && szAmts.length) {
    const n = Math.min(shAmts.length, szAmts.length);
    const sum2 = (i) =>
      (shAmts[shAmts.length - n + i]?.amount || 0)
      + (szAmts[szAmts.length - n + i]?.amount || 0);
    const todayAmt = sum2(n - 1);
    const latestTradeDate = shAmts.at(-1)?.date || szAmts.at(-1)?.date;
    volumeComparison = volumeComparisonContext(latestTradeDate);
    const previous = [];
    for (let i = 0; i < n - 1; i++) previous.push(sum2(i));
    const avg5 = previous.length
      ? previous.slice(-5).reduce((a, b) => a + b, 0)
        / Math.min(5, previous.length)
      : 0;
    if (todayAmt > 0) marketAmountYi = +(todayAmt / 1e8).toFixed(0);
    if (todayAmt > 0 && avg5 > 0) {
      volVsAvg5 = +((todayAmt / avg5 - 1) * 100).toFixed(1);
      volLevel = volVsAvg5 >= 15
        ? '放量'
        : volVsAvg5 <= -15 ? '缩量' : '平量';
    }
  }
  const sentiment = summarizeMarketSentiment({
    limitUpPool: ztPool,
    limitDownPool: dtPool,
    brokenLimitPool: zbPool,
  });

  return {
    ok: true,
    updatedAt: Date.now(),
    indices,
    breadth: {
      up: marketBreadth.up,
      down: marketBreadth.down,
      flat: marketBreadth.flat,
      limitUp: marketBreadth.limitUp,
      limitDown: marketBreadth.limitDown,
      total: marketBreadth.total,
      complete: marketBreadth.complete,
      amountYi: marketAmountYi,
      volVsAvg5,
      volLevel,
      volumeComparable: volumeComparison.comparable,
      volumeTradeDate: volumeComparison.tradeDate,
    },
    sentiment,
  };
}

// 大盘情绪：指数 + 涨跌家数 + 涨停/跌停统计 + 主力净流入
export default async function handler(req, res) {
  // 外部宏观快讯聚合分流（供盘面研究「外部宏观经济分析」使用）
  if (req.query && req.query.news === '1') return handleNews(res);
  try {
    sendJson(
      res,
      await fetchMarketSnapshot(),
      { cache: 20 }
    );
  } catch (e) {
    sendError(res, e);
  }
}
