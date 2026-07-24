import { emGet, num } from './_lib.js';

// 选股筛选核心逻辑（共享模块，不占 serverless 函数名额）
// opts: { sort, dir, limit, minPct, maxPct, minTurnover, minVolRatio, minInflowYi, onlyLimitUp }
export async function screenStocks(opts = {}) {
  const sortMap = { main: 'f62', pct: 'f3', turnover: 'f8', volratio: 'f10', speed: 'f22', amount: 'f6' };
  const fid = sortMap[opts.sort] || 'f62';
  const po = opts.dir === 'asc' ? '0' : '1';
  const limit = Math.min(Number(opts.limit) || 20, 50);

  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  const fields = 'f12,f14,f2,f3,f22,f62,f184,f8,f10,f6';
  const path =
    `/api/qt/clist/get?pn=1&pz=200&po=${po}&np=1&fltt=2&invt=2` +
    `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;

  const j = await emGet(path);
  const diff = (j && j.data && j.data.diff) || [];
  let list = diff.map((d) => ({
    code: d.f12, name: d.f14, price: num(d.f2), pct: num(d.f3),
    speed: num(d.f22), mainInflow: num(d.f62), mainRatio: num(d.f184),
    turnover: num(d.f8), volRatio: num(d.f10), amount: num(d.f6),
    isLimitUp: num(d.f3) >= 9.8,
  }));

  const f = (k) => (opts[k] !== undefined && opts[k] !== '' && opts[k] !== null ? Number(opts[k]) : null);
  const minPct = f('minPct'), maxPct = f('maxPct'), minTurnover = f('minTurnover');
  const minVolRatio = f('minVolRatio'), minInflowYi = f('minInflowYi');
  const onlyLimitUp = opts.onlyLimitUp === true || opts.onlyLimitUp === 'true';
  list = list.filter((s) => {
    if (minPct !== null && s.pct < minPct) return false;
    if (maxPct !== null && s.pct > maxPct) return false;
    if (minTurnover !== null && s.turnover < minTurnover) return false;
    if (minVolRatio !== null && s.volRatio < minVolRatio) return false;
    if (minInflowYi !== null && s.mainInflow / 1e8 < minInflowYi) return false;
    if (onlyLimitUp && !s.isLimitUp) return false;
    return true;
  });

  return list.slice(0, limit);
}
