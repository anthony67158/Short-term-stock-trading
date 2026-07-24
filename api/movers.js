import { emGet, sendJson, sendError, num } from './_lib.js';

// 盘中异动：全市场按主力净流入 / 涨速排序，取最活跃个股
// query: kind=inflow(主力抢筹) | speed(涨速) | outflow(主力出逃)
export default async function handler(req, res) {
  try {
    const kind = req.query.kind || 'inflow';
    let fid = 'f62'; // 主力净流入
    let po = '1';
    if (kind === 'speed') { fid = 'f22'; po = '1'; }    // 涨速
    if (kind === 'outflow') { fid = 'f62'; po = '0'; }  // 净流出(升序)

    // 全 A 股（排除 ST、退市、次新可选）
    const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
    const fields = 'f12,f14,f2,f3,f22,f62,f184,f8,f10,f6';
    const path =
      `/api/qt/clist/get?pn=1&pz=30&po=${po}&np=1&fltt=2&invt=2` +
      `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;

    const j = await emGet(path);
    const diff = (j && j.data && j.data.diff) || [];
    const list = diff.map((d) => ({
      code: d.f12,
      name: d.f14,
      price: num(d.f2),
      pct: num(d.f3),
      speed: num(d.f22),        // 涨速(%)
      mainInflow: num(d.f62),
      mainRatio: num(d.f184),
      turnover: num(d.f8),
      volRatio: num(d.f10),
      isLimitUp: num(d.f3) >= 9.8,
    }));

    sendJson(res, { ok: true, kind, updatedAt: Date.now(), list }, { cache: 15 });
  } catch (e) {
    sendError(res, e);
  }
}
