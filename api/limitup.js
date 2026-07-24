import { sendJson, sendError, num } from './_lib.js';

const ZT_HOSTS = [
  'https://push2ex.eastmoney.com',
  'https://push2ex.eastmoney.com',
];

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
  // 东八区日期
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const day = String(bj.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// 涨停池 / 炸板池
// query: kind=zt(涨停) | zb(炸板)
export default async function handler(req, res) {
  try {
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
      price: num(d.p) / 1000,          // 东财价格放大1000
      limitTimes: (d.zttj && num(d.zttj.days)) || 0,   // 几天几板-天数
      boardCount: (d.zttj && num(d.zttj.ct)) || 0,     // 涨停次数
      lbc: num(d.lbc),                 // 连板数
      fundAmount: num(d.fund),         // 封板资金(元)
      firstTime: d.fbt,                // 首次封板时间(HHMMSS)
      lastTime: d.lbt,                 // 最后封板时间
      breakTimes: num(d.zbc),          // 炸板次数
      turnover: num(d.hs),             // 换手率
      sector: d.hybk,                  // 所属行业
      amount: num(d.amount),
    }));

    sendJson(res, { ok: true, kind, date, updatedAt: Date.now(), list }, { cache: 20 });
  } catch (e) {
    sendError(res, e);
  }
}
