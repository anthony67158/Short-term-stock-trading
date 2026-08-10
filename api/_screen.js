import { emGetOne, num } from './_lib.js';
import { marketPageNumbers, rankMarketCandidates } from '../shared/stockRanking.js';

let marketUniverseCache = { at: 0, value: null };

// 选股筛选核心逻辑（共享模块，不占 serverless 函数名额）
// opts: { sort, dir, limit, minPct, maxPct, minTurnover, minVolRatio, minInflowYi, onlyLimitUp }
async function fetchUniverse(opts = {}) {
  const sortMap = { main: 'f62', pct: 'f3', turnover: 'f8', volratio: 'f10', speed: 'f22', amount: 'f6' };
  const fid = sortMap[opts.sort] || 'f62';
  const po = opts.dir === 'asc' ? '0' : '1';

  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  const fields = 'f12,f14,f2,f3,f22,f62,f184,f8,f10,f6';
  const pageSize = 100;
  const pathFor = (page) =>
    `/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=${po}&np=1&fltt=2&invt=2` +
    `&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${fields}`;
  const deadline = Date.now() + 28000;
  const first = await emGetOne(pathFor(1));
  const total = Number(first && first.data && first.data.total) || 0;
  const diffs = [...((first && first.data && first.data.diff) || [])];
  const remaining = marketPageNumbers(total, pageSize).slice(1);
  for (let i = 0; i < remaining.length; i += 8) {
    if (Date.now() >= deadline) break;
    const batch = remaining.slice(i, i + 8);
    const pages = await Promise.all(batch.map((page) =>
      emGetOne(pathFor(page), { hostIndex: page }).catch(() => null)
    ));
    for (const page of pages) diffs.push(...((page && page.data && page.data.diff) || []));
  }
  const mapped = diffs.map((d) => ({
    code: d.f12, name: d.f14, price: num(d.f2), pct: num(d.f3),
    speed: num(d.f22), mainInflow: num(d.f62), mainRatio: num(d.f184),
    turnover: num(d.f8), volRatio: num(d.f10), amount: num(d.f6),
    isLimitUp: num(d.f3) >= 9.8,
  }));
  const list = [...new Map(mapped.filter((item) => item.code).map((item) => [item.code, item])).values()];
  return { list, total };
}

async function getMarketUniverse() {
  let universe = marketUniverseCache.value;
  if (!universe || Date.now() - marketUniverseCache.at > 60000) {
    universe = await fetchUniverse({ sort: 'amount' });
    if (universe.list.length >= universe.total * 0.98) {
      marketUniverseCache = { at: Date.now(), value: universe };
    }
  }
  return universe;
}

export async function screenMarketCandidates(opts = {}) {
  const universe = await getMarketUniverse();
  const ranked = rankMarketCandidates(universe.list, opts);
  return { ...ranked, universeCount: universe.total || ranked.universeCount, scannedCount: universe.list.length };
}

export async function screenStocks(opts = {}) {
  const limit = Math.min(Number(opts.limit) || 20, 50);
  let { list } = await getMarketUniverse();

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

  const sortKey = {
    main: 'mainInflow', pct: 'pct', turnover: 'turnover',
    volratio: 'volRatio', speed: 'speed', amount: 'amount',
  }[opts.sort] || 'mainInflow';
  const direction = opts.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => (Number(a[sortKey]) - Number(b[sortKey])) * direction);
  return list.slice(0, limit);
}
