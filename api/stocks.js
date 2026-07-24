import { emGet, sendJson, sendError, num } from './_lib.js';

// 板块内个股榜
// query: code=板块代码(BKxxxx)  sort=pct(涨幅)|down(跌幅)|main(资金)
export default async function handler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return sendJson(res, { ok: false, error: 'missing code' });

    const sort = req.query.sort || 'pct';
    let fid = 'f3'; // 涨跌幅
    let po = '1';   // 1=降序 0=升序
    if (sort === 'down') { fid = 'f3'; po = '0'; }
    if (sort === 'main') { fid = 'f62'; po = '1'; }

    // 板块成分股: fs=b:BKxxxx
    const fs = `b:${code}+f:!50`; // 排除退市
    // fields: 代码,名称,现价,涨跌幅,涨跌额,换手率,量比,主力净流入,主力净占比,
    //         成交额,涨停价,是否涨停(用f10量比不够，改用f3判断)
    const fields = 'f12,f14,f2,f3,f4,f8,f10,f62,f184,f6,f7';
    const path =
      `/api/qt/clist/get?pn=1&pz=40&po=${po}&np=1&fltt=2&invt=2` +
      `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;

    const j = await emGet(path);
    const diff = (j && j.data && j.data.diff) || [];
    const list = diff.map((d) => ({
      code: d.f12,
      name: d.f14,
      price: num(d.f2),
      pct: num(d.f3),
      chg: num(d.f4),
      turnover: num(d.f8),      // 换手率
      volRatio: num(d.f10),     // 量比
      mainInflow: num(d.f62),   // 主力净流入
      mainRatio: num(d.f184),   // 主力净占比
      amount: num(d.f6),        // 成交额
      amplitude: num(d.f7),     // 振幅
      isLimitUp: num(d.f3) >= 9.8,   // 近似涨停判断
      isLimitDown: num(d.f3) <= -9.8,
    }));

    sendJson(res, { ok: true, code, sort, updatedAt: Date.now(), list }, { cache: 20 });
  } catch (e) {
    sendError(res, e);
  }
}
