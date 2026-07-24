import { emGet, sendJson, sendError, num } from './_lib.js';

// 任意股票实时报价（自选股用）
// query: codes=600519,000858,300750
function toSecid(code) {
  const c = String(code).trim();
  // 6/9 开头沪市=1，0/3 开头深市=0，4/8 北交所=0
  if (/^(6|9|5)/.test(c)) return '1.' + c;
  return '0.' + c;
}

export default async function handler(req, res) {
  try {
    const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) return sendJson(res, { ok: true, list: [] });

    const secids = codes.map(toSecid).join(',');
    // f15 最高 f16 最低 f17 今开 f18 昨收
    const fields = 'f2,f3,f4,f8,f10,f12,f14,f62,f184,f6,f15,f16,f17,f18';
    const path =
      `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${encodeURIComponent(secids)}` +
      `&fields=${fields}`;

    const j = await emGet(path);
    const diff = (j && j.data && j.data.diff) || [];
    const list = diff.map((d) => ({
      code: d.f12,
      name: d.f14,
      price: num(d.f2),
      pct: num(d.f3),
      chg: num(d.f4),
      turnover: num(d.f8),
      volRatio: num(d.f10),
      mainInflow: num(d.f62),
      mainRatio: num(d.f184),
      amount: num(d.f6),
      high: num(d.f15),      // 日内最高
      low: num(d.f16),       // 日内最低
      open: num(d.f17),      // 今开
      prevClose: num(d.f18), // 昨收
      isLimitUp: num(d.f3) >= 9.8,
      isLimitDown: num(d.f3) <= -9.8,
    }));

    sendJson(res, { ok: true, updatedAt: Date.now(), list }, { cache: 10 });
  } catch (e) {
    sendError(res, e);
  }
}
