import { emGet, sendJson, sendError, num } from './_lib.js';

// 板块资金流向排行
// query: type=industry|concept   sort=main(主力净流入)|pct(涨跌幅)
export default async function handler(req, res) {
  try {
    const type = (req.query.type || 'industry') === 'concept' ? 'concept' : 'industry';
    const fs = type === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
    const fid = req.query.sort === 'pct' ? 'f3' : 'f62'; // f62=主力净流入
    // po=1 降序（默认）；拉全量板块，确保流入/流出两端都覆盖
    const po = req.query.po === '0' ? '0' : '1';

    // fields: 代码,名称,现价,涨跌幅,主力净流入,主力净占比,超大单净额,大单净额,
    //         领涨股名,领涨股代码,领涨股涨幅,换手率,成交额
    const fields =
      'f12,f14,f2,f3,f62,f184,f66,f72,f78,f84,f204,f205,f206,f8,f6';
    // pz 拉到 500，行业约86/概念约360个板块全覆盖，避免尾部净流出板块被截断
    const path =
      `/api/qt/clist/get?pn=1&pz=500&po=${po}&np=1&fltt=2&invt=2` +
      `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;

    const j = await emGet(path);
    const diff = (j && j.data && j.data.diff) || [];
    const list = diff.map((d) => ({
      code: d.f12,
      name: d.f14,
      price: num(d.f2),
      pct: num(d.f3),
      mainInflow: num(d.f62),        // 主力净流入(元)
      mainRatio: num(d.f184),        // 主力净占比(%)
      superInflow: num(d.f66),       // 超大单净额
      turnover: num(d.f8),           // 换手率
      amount: num(d.f6),             // 成交额
      leadName: d.f204,              // 领涨股
      leadCode: d.f205,
      leadPct: num(d.f206),
    }));

    sendJson(res, { ok: true, type, updatedAt: Date.now(), list }, { cache: 30 });
  } catch (e) {
    sendError(res, e);
  }
}
