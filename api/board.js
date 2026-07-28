import { emGet, sendJson, sendError, num } from './_lib.js';

// ============ 盘面数据聚合接口（合并原 limitup + movers，节省 Vercel 函数位）============
// query:
//   type=limitup&kind=zt|zb            涨停池 / 炸板池
//   type=movers&kind=inflow|speed|outflow  盘中异动（主力抢筹/涨速/主力出逃）

async function ztFetch(path, timeout = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch('https://push2ex.eastmoney.com' + path, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://quote.eastmoney.com/',
        Accept: '*/*',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function todayStr() {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const day = String(bj.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ---- 涨停池 / 炸板池 ----
async function limitup(req, res) {
  const kind = req.query.kind === 'zb' ? 'zb' : 'zt';
  const date = req.query.date || todayStr();
  const ut = '7eea3edcaed734bea9cbfc24409ed989';
  const path =
    kind === 'zb'
      ? `/getTopicZBPool?ut=${ut}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=zbt%3Aasc&date=${date}&_=${Date.now()}`
      : `/getTopicZTPool?ut=${ut}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${date}&_=${Date.now()}`;
  const j = await ztFetch(path);
  const pool = (j && j.data && j.data.pool) || [];
  const list = pool.map((d) => ({
    code: d.c,
    name: d.n,
    pct: num(d.zdp),
    price: num(d.p) / 1000,
    limitTimes: (d.zttj && num(d.zttj.days)) || 0,
    boardCount: (d.zttj && num(d.zttj.ct)) || 0,
    lbc: num(d.lbc),
    fundAmount: num(d.fund),
    firstTime: d.fbt,
    lastTime: d.lbt,
    breakTimes: num(d.zbc),
    turnover: num(d.hs),
    sector: d.hybk,
    amount: num(d.amount),
  }));
  sendJson(res, { ok: true, kind, date, updatedAt: Date.now(), list }, { cache: 20 });
}

// ---- 盘中异动 ----
async function movers(req, res) {
  const kind = req.query.kind || 'inflow';
  let fid = 'f62', po = '1';
  if (kind === 'speed') { fid = 'f22'; po = '1'; }
  if (kind === 'outflow') { fid = 'f62'; po = '0'; }
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
    speed: num(d.f22),
    mainInflow: num(d.f62),
    mainRatio: num(d.f184),
    turnover: num(d.f8),
    volRatio: num(d.f10),
    isLimitUp: num(d.f3) >= 9.8,
  }));
  sendJson(res, { ok: true, kind, updatedAt: Date.now(), list }, { cache: 15 });
}

export default async function handler(req, res) {
  try {
    const type = req.query.type || 'movers';
    if (type === 'limitup') return await limitup(req, res);
    return await movers(req, res);
  } catch (e) {
    sendError(res, e);
  }
}
