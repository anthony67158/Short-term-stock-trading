import { emGet, sendJson, sendError, num } from './_lib.js';
import { fetchClsTelegraph, fetchSinaFlash, fetchNews } from './_market_data.js';

// 盘面研究·外部宏观快讯聚合（合并入 market 端点以规避 Hobby 12 函数上限）
// GET /api/market?news=1 → { ok, macro:[{title,date,url}], flashes:[{title,src,date,url,level}] }
// 数据源：财联社系/金十/东财聚合(fetchClsTelegraph) + 新浪7×24(fetchSinaFlash) + 东财宏观检索(fetchNews)。
async function handleNews(res) {
  try {
    const [cls, sina, macro] = await Promise.all([
      fetchClsTelegraph(20).catch(() => []),
      fetchSinaFlash(16).catch(() => []),
      fetchNews('宏观 政策 央行 A股 美联储 关税 市场', 10).catch(() => []),
    ]);
    const seen = new Set();
    const flashes = [...(cls || []), ...(sina || [])]
      .filter((n) => {
        const k = (n.title || '').slice(0, 24);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
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
      const pool = [...(cls || []), ...(sina || [])].filter((x) => x && x.title);
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

// 大盘情绪：指数 + 涨跌家数 + 涨停/跌停统计 + 主力净流入
export default async function handler(req, res) {
  // 外部宏观快讯聚合分流（供盘面研究「外部宏观经济分析」使用）
  if (req.query && req.query.news === '1') return handleNews(res);
  try {
    // 1) 三大指数 + 北证
    const idxSecids = '1.000001,0.399001,0.399006,0.899050';
    const idxFields = 'f2,f3,f4,f12,f14,f6';
    const idxPath =
      `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${encodeURIComponent(idxSecids)}` +
      `&fields=${idxFields}`;

    // 2) 全市场涨跌家数统计 (沪深京 A股) — 单次请求
    const marketFs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

    const [idxJson, upDownJson, shK, szK] = await Promise.all([
      emGet(idxPath).catch(() => null),
      emGet(
        `/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3` +
          `&fs=${encodeURIComponent(marketFs)}&fields=f3,f6`  // f6=成交额,用于全市场实时量能
      ).catch(() => null),
      // 上证综指 / 深证成指 日K(取成交额 f57),用于"两市成交额"与近5日均量对比(放量/缩量)
      // 注:kline 接口仅 push2his 镜像提供,必须走 { his: true },否则默认 push2 host 返回 502 → 量能因子丢失
      emGet(`/api/qt/stock/kline/get?secid=1.000001&fields1=f1&fields2=f51,f57&klt=101&fqt=1&end=20500101&lmt=6`, { his: true }).catch(() => null),
      emGet(`/api/qt/stock/kline/get?secid=0.399001&fields1=f1&fields2=f51,f57&klt=101&fqt=1&end=20500101&lmt=6`, { his: true }).catch(() => null),
    ]);

    // 指数
    const indices = ((idxJson && idxJson.data && idxJson.data.diff) || []).map((d) => ({
      code: d.f12,
      name: d.f14,
      price: num(d.f2),
      pct: num(d.f3),
      chg: num(d.f4),
      amount: num(d.f6),
    }));

    // 涨跌家数 & 涨停跌停 & 全市场实时成交额(量能)
    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
    let amountSum = 0;  // 全市场成交额合计(元)
    const diffs = (upDownJson && upDownJson.data && upDownJson.data.diff) || [];
    for (const d of diffs) {
      const p = num(d.f3);
      if (p > 0) up++;
      else if (p < 0) down++;
      else flat++;
      if (p >= 9.8) limitUp++;
      if (p <= -9.8) limitDown++;
      const a = num(d.f6);
      if (a != null && a > 0) amountSum += a;
    }
    // 全市场实时成交额(亿元);盘中为进行中累计,盘后为当日收盘值
    const clistAmountYi = amountSum > 0 ? +(amountSum / 1e8).toFixed(0) : null;

    // 两市成交额 + 近5日均量对比(放量/缩量)——用沪市/深市指数日K的成交额 f57
    // klines: [{f51:date, f57:amount(元)}]；末根为今日(盘中为进行中累计,盘后为收盘值)
    const klAmt = (kJson) => {
      const kl = (kJson && kJson.data && kJson.data.klines) || [];
      return kl.map((s) => {
        const parts = String(s).split(',');
        return +parts[1] || 0;  // fields2=f51,f57 → [date, amount]
      });
    };
    const shAmts = klAmt(shK), szAmts = klAmt(szK);
    let marketAmountYi = clistAmountYi, volVsAvg5 = null, volLevel = null;
    if (shAmts.length && szAmts.length) {
      const n = Math.min(shAmts.length, szAmts.length);
      const sum2 = (i) => (shAmts[shAmts.length - n + i] || 0) + (szAmts[szAmts.length - n + i] || 0);
      const todayAmt = sum2(n - 1);                         // 今日两市成交额(元)
      const prev = [];
      for (let i = 0; i < n - 1; i++) prev.push(sum2(i));   // 之前若干日
      const avg5 = prev.length ? prev.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, prev.length) : 0;
      if (todayAmt > 0) marketAmountYi = +(todayAmt / 1e8).toFixed(0);
      if (todayAmt > 0 && avg5 > 0) {
        volVsAvg5 = +((todayAmt / avg5 - 1) * 100).toFixed(1);  // 较5日均量的百分比(±)
        volLevel = volVsAvg5 >= 15 ? '放量' : volVsAvg5 <= -15 ? '缩量' : '平量';
      }
    }

    sendJson(
      res,
      {
        ok: true,
        updatedAt: Date.now(),
        indices,
        breadth: {
          up, down, flat, limitUp, limitDown, total: diffs.length,
          amountYi: marketAmountYi,   // 两市成交额(亿元)
          volVsAvg5,                  // 较近5日均量的偏离%(+放量/-缩量)
          volLevel,                   // 放量/平量/缩量
        },
      },
      { cache: 20 }
    );
  } catch (e) {
    sendError(res, e);
  }
}
