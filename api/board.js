import { emGet, sendJson, sendError, num } from './_lib.js';
import { snapshotsHandler } from './_sector_snapshots.js';
import { fetchLimitPool, limitPoolDay } from './_limit_pool.js';
import { classifyPriceLimit } from '../shared/priceLimitPolicy.js';

// ============ 盘面数据聚合接口（合并原 limitup + movers，节省 Vercel 函数位）============
// query:
//   type=limitup&kind=zt|dt|zb         涨停池 / 跌停池 / 炸板池
//   type=movers&kind=inflow|speed|outflow  盘中异动（主力抢筹/涨速/主力出逃）

// ---- 涨停池 / 跌停池 / 炸板池 ----
async function limitup(req, res) {
  const kind = ['zt', 'dt', 'zb'].includes(req.query.kind) ? req.query.kind : 'zt';
  const date = req.query.date || limitPoolDay();
  const result = await fetchLimitPool(kind, date);
  sendJson(res, { ok: true, ...result, updatedAt: Date.now() }, { cache: 20 });
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
  const list = diff.map((d) => {
    const stock = {
      code: d.f12,
      name: d.f14,
      price: num(d.f2),
      pct: num(d.f3),
      speed: num(d.f22),
      mainInflow: num(d.f62),
      mainRatio: num(d.f184),
      turnover: num(d.f8),
      volRatio: num(d.f10),
    };
    return { ...stock, ...classifyPriceLimit(stock) };
  });
  sendJson(res, { ok: true, kind, updatedAt: Date.now(), list }, { cache: 15 });
}

// ---- 游资龙虎榜（东方财富数据中心公开接口）----
// 知名游资/席位别名（营业部正式名含以下关键字 → 江湖名）
const SEAT_ALIAS = [
  ['中山东路', '章盟主'],
  ['佛山绿景路', '佛山无影脚'],
  ['成都南一环路', '成都帮'],
  ['杭州上塘路', '杭州帮'],
  ['宁波桑田路', '宁波桑田路'],
  ['宁波中山西路', '宁波涨停帮'],
  ['深圳欢乐海岸', '欢乐海岸'],
  ['上海溧阳路', '上海溧阳路'],
  ['拉萨团结路', '拉萨天团'],
  ['拉萨东环路', '拉萨天团'],
  ['拉萨金珠西路', '拉萨天团'],
  ['深股通专用', '深股通(北向)'],
  ['沪股通专用', '沪股通(北向)'],
  ['机构专用', '机构专用'],
];
function seatAlias(name) {
  if (!name) return '';
  for (const [k, v] of SEAT_ALIAS) if (name.indexOf(k) >= 0) return v;
  return '';
}

async function dcGet(reportName, extra) {
  const base =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?source=WEB&client=WEB` +
    `&reportName=${reportName}&${extra}&_=${Date.now()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(base, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://data.eastmoney.com/',
        Accept: '*/*',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j && j.result && j.result.data) || [];
  } finally {
    clearTimeout(t);
  }
}

async function lhb(req, res) {
  // 1. 探测最新交易日
  const probe = await dcGet(
    'RPT_DAILYBILLBOARD_DETAILSNEW',
    'columns=TRADE_DATE&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=1'
  );
  const date = (probe[0] && String(probe[0].TRADE_DATE).slice(0, 10)) || limitPoolDay();
  const flt = `filter=${encodeURIComponent(`(TRADE_DATE='${date}')`)}`;

  // 2. 当日上榜个股明细（按净买额排序）
  const detail = await dcGet(
    'RPT_DAILYBILLBOARD_DETAILSNEW',
    'columns=SECURITY_CODE,SECURITY_NAME_ABBR,CLOSE_PRICE,CHANGE_RATE,TURNOVERRATE,' +
      'BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,ACCUM_AMOUNT,EXPLANATION' +
      `&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1&pageSize=100&${flt}`
  );
  const nameMap = {};
  const stocks = detail.map((d) => {
    nameMap[d.SECURITY_CODE] = d.SECURITY_NAME_ABBR;
    return {
      code: d.SECURITY_CODE,
      name: d.SECURITY_NAME_ABBR,
      price: num(d.CLOSE_PRICE),
      pct: num(d.CHANGE_RATE),
      turnover: num(d.TURNOVERRATE),
      net: num(d.BILLBOARD_NET_AMT),
      buy: num(d.BILLBOARD_BUY_AMT),
      sell: num(d.BILLBOARD_SELL_AMT),
      amount: num(d.ACCUM_AMOUNT),
      reason: d.EXPLANATION || '',
    };
  });

  // 3. 当日买方席位明细 → 聚合成活跃游资/机构榜
  const buySeats = await dcGet(
    'RPT_BILLBOARD_DAILYDETAILSBUY',
    'columns=OPERATEDEPT_NAME,SECURITY_CODE,BUY,SELL,NET' +
      `&sortColumns=NET&sortTypes=-1&pageSize=200&${flt}`
  );
  const agg = {};
  for (const s of buySeats) {
    const nm = s.OPERATEDEPT_NAME || '未知席位';
    if (!agg[nm]) agg[nm] = { name: nm, alias: seatAlias(nm), buy: 0, net: 0, picks: [] };
    agg[nm].buy += num(s.BUY);
    agg[nm].net += num(s.NET);
    const stkName = nameMap[s.SECURITY_CODE] || s.SECURITY_CODE;
    if (num(s.NET) > 0 && agg[nm].picks.length < 3 && !agg[nm].picks.find((p) => p.code === s.SECURITY_CODE))
      agg[nm].picks.push({ code: s.SECURITY_CODE, name: stkName, net: num(s.NET) });
  }
  const seats = Object.values(agg)
    .sort((a, b) => b.net - a.net)
    .slice(0, 24);

  sendJson(res, { ok: true, date, updatedAt: Date.now(), stocks, seats }, { cache: 300 });
}

export default async function handler(req, res) {
  try {
    const type = req.query.type || 'movers';
    if (type === 'limitup') return await limitup(req, res);
    if (type === 'lhb') return await lhb(req, res);
    if (type === 'snapshots') return await snapshotsHandler(req, res);
    return await movers(req, res);
  } catch (e) {
    sendError(res, e);
  }
}
