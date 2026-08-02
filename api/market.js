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
    const macroList = (macro || [])
      .map((n) => ({ title: n.title, date: n.date || '', url: n.url || '' }))
      .filter((n) => n.title)
      .slice(0, 10);
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

    const [idxJson, upDownJson] = await Promise.all([
      emGet(idxPath).catch(() => null),
      emGet(
        `/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3` +
          `&fs=${encodeURIComponent(marketFs)}&fields=f3`
      ).catch(() => null),
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

    // 涨跌家数 & 涨停跌停
    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
    const diffs = (upDownJson && upDownJson.data && upDownJson.data.diff) || [];
    for (const d of diffs) {
      const p = num(d.f3);
      if (p > 0) up++;
      else if (p < 0) down++;
      else flat++;
      if (p >= 9.8) limitUp++;
      if (p <= -9.8) limitDown++;
    }

    sendJson(
      res,
      {
        ok: true,
        updatedAt: Date.now(),
        indices,
        breadth: { up, down, flat, limitUp, limitDown, total: diffs.length },
      },
      { cache: 20 }
    );
  } catch (e) {
    sendError(res, e);
  }
}
