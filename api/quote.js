import { emGet, sendJson, sendError, num } from './_lib.js';
import { beijingDayKey } from '../shared/tradingCalendar.js';
import { classifyPriceLimit } from '../shared/priceLimitPolicy.js';

// 任意股票实时报价（自选股用）
// query: codes=600519,000858,300750
export function toSecid(code) {
  const c = String(code).trim();
  // 北交所新代码 920 不能按 9 开头误归上海市场。
  if (/^(4|8|92)/.test(c)) return '0.' + c;
  if (/^(6|9|5)/.test(c)) return '1.' + c;
  return '0.' + c;
}
function toTxCode(code) {
  const c = String(code).trim();
  if (/^(4|8|92)/.test(c)) return 'bj' + c;
  return (/^(6|9|5)/.test(c) ? 'sh' : 'sz') + c;
}

export function withPriceLimitState(quote) {
  return { ...quote, ...classifyPriceLimit(quote) };
}

export function mapEastmoneyQuote(data = {}) {
  return withPriceLimitState({
    code: data.f12,
    name: data.f14,
    source: '东方财富',
    price: num(data.f2),
    pct: num(data.f3),
    chg: num(data.f4),
    turnover: num(data.f8),
    volRatio: num(data.f10),
    mainInflow: num(data.f62),
    retailInflow: num(data.f84),
    mainRatio: num(data.f184),
    amount: num(data.f6),
    high: num(data.f15),
    low: num(data.f16),
    open: num(data.f17),
    prevClose: num(data.f18),
    tradeDate: num(data.f124) > 0
      ? beijingDayKey(num(data.f124) * 1000)
      : null,
    industry: (data.f100 && data.f100 !== '-')
      ? data.f100
      : null,
  });
}

// 备用源：腾讯批量报价（海外稳、基本不限流）。只取跨版本稳定的数字字段，涨跌幅自算。
async function quoteTx(codes) {
  const q = codes.map(toTxCode).join(',');
  const url = `https://qt.gtimg.cn/q=${q}&_=${Date.now()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  let text = '';
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    });
    if (!res.ok) return [];
    const buf = await res.arrayBuffer();
    text = Buffer.from(buf).toString('latin1'); // 数字字段是 ASCII，名称可能乱码(不用)
  } catch { return []; } finally { clearTimeout(t); }
  // 每行：v_sh600519="1~名称~600519~现价~昨收~今开~成交量(手)~...~最高~最低~...";
  const out = [];
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[2].split('~');
    if (p.length < 6) continue;
    const price = num(p[3]), prevClose = num(p[4]);
    const rawCode = m[1].slice(2);
    const pct = prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0;
    const quoteStamp = String(p[30] || '').match(/^(\d{4})(\d{2})(\d{2})/);
    out.push(withPriceLimitState({
      code: rawCode,
      name: '',                 // 名称留空，前端用本地已有名称
      source: '腾讯财经',
      price, pct,
      chg: prevClose ? +(price - prevClose).toFixed(3) : 0,
      turnover: num(p[38]) || null,   // 换手率(腾讯常见位)
      volRatio: num(p[49]) || null,   // 量比(腾讯常见位)
      mainInflow: null, retailInflow: null, mainRatio: null,
      amount: num(p[37]) ? num(p[37]) * 10000 : null, // 成交额(万元→元)
      high: num(p[33]) || null, low: num(p[34]) || null, open: num(p[5]) || null,
      prevClose,
      tradeDate: quoteStamp ? `${quoteStamp[1]}-${quoteStamp[2]}-${quoteStamp[3]}` : null,
      industry: null,
    }));
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) return sendJson(res, { ok: true, list: [] });

    const secids = codes.map(toSecid).join(',');
    // f15 最高 f16 最低 f17 今开 f18 昨收 f100 所属行业
    const fields = 'f2,f3,f4,f8,f10,f12,f14,f62,f84,f184,f6,f15,f16,f17,f18,f100,f124';
    const path =
      `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${encodeURIComponent(secids)}` +
      `&fields=${fields}`;

    let list = [];
    try {
      const j = await emGet(path);
      const diff = (j && j.data && j.data.diff) || [];
      list = diff.map(mapEastmoneyQuote);
    } catch { /* 东财失败 → 走腾讯 */ }

    // 东财空或缺票 → 用腾讯补齐缺失的代码
    const have = new Set(list.map((x) => x.code));
    const missing = codes.filter((c) => !have.has(c));
    if (missing.length) {
      try {
        const tx = await quoteTx(missing);
        list = [...list, ...tx];
      } catch { /* 腾讯也失败则保持现状 */ }
    }

    sendJson(res, { ok: true, updatedAt: Date.now(), list }, { cache: 10 });
  } catch (e) {
    sendError(res, e);
  }
}
