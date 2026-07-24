import { emGet, sendJson, sendError, num } from './_lib.js';

// 大盘情绪：指数 + 涨跌家数 + 涨停/跌停统计 + 主力净流入
export default async function handler(req, res) {
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
