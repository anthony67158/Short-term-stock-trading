import { emGet, sendJson, sendError, num } from './_lib.js';
import {
  beijingDayKey,
  beijingMinutes,
  isContinuousTrading,
  isTradingDayAt,
} from '../shared/tradingCalendar.js';
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

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? number
    : null;
}

function quoteDisplayState(tradeDate, now) {
  const today = beijingDayKey(now);
  if (String(tradeDate || '').slice(0, 10) !== today) {
    return {
      priceStatus: 'PREVIOUS_CLOSE',
      priceLabel: (
        isTradingDayAt(now) && beijingMinutes(now) < 570
          ? '昨收'
          : '最近收盘'
      ),
      isLivePrice: false,
    };
  }
  const minutes = beijingMinutes(now);
  if (isContinuousTrading(now)) {
    return {
      priceStatus: 'LIVE',
      priceLabel: '',
      isLivePrice: true,
    };
  }
  if (minutes >= 555 && minutes < 570) {
    return {
      priceStatus: 'AUCTION',
      priceLabel: '竞价',
      isLivePrice: false,
    };
  }
  if (minutes >= 690 && minutes < 780) {
    return {
      priceStatus: 'LUNCH_CLOSE',
      priceLabel: '午间收盘',
      isLivePrice: false,
    };
  }
  if (minutes >= 900) {
    return {
      priceStatus: 'CLOSE',
      priceLabel: '收盘',
      isLivePrice: false,
    };
  }
  return {
    priceStatus: 'LATEST',
    priceLabel: '最新',
    isLivePrice: false,
  };
}

function previousCloseQuote(code, eastmoney, tencent, now) {
  const today = beijingDayKey(now);
  const eastmoneyCurrentDay = (
    String(eastmoney?.tradeDate || '').slice(0, 10) === today
  );
  const price = (
    (!positive(eastmoney?.price) && eastmoneyCurrentDay
      ? positive(eastmoney?.prevClose)
      : null)
    || positive(tencent?.price)
    || positive(eastmoney?.price)
    || positive(eastmoney?.prevClose)
    || positive(tencent?.prevClose)
  );
  if (price == null) {
    return withPriceLimitState({
      ...(eastmoney || tencent || {}),
      code,
      price: null,
      pct: null,
      chg: null,
      priceStatus: 'UNAVAILABLE',
      priceLabel: '暂无报价',
      isLivePrice: false,
    });
  }
  const sourceTradeDate = (
    String(tencent?.tradeDate || '').slice(0, 10) !== today
      ? tencent?.tradeDate || null
      : null
  );
  return withPriceLimitState({
    ...(eastmoney || {}),
    code,
    name: eastmoney?.name || tencent?.name || '',
    industry: eastmoney?.industry || tencent?.industry || null,
    source: tencent
      ? '腾讯财经·最近收盘'
      : '东方财富·昨收',
    price,
    pct: 0,
    chg: 0,
    turnover: null,
    volRatio: null,
    mainInflow: null,
    retailInflow: null,
    mainRatio: null,
    amount: null,
    high: null,
    low: null,
    open: null,
    prevClose: price,
    tradeDate: sourceTradeDate,
    priceStatus: 'PREVIOUS_CLOSE',
    priceLabel: (
      isTradingDayAt(now) && beijingMinutes(now) < 570
        ? '昨收'
        : '最近收盘'
    ),
    isLivePrice: false,
  });
}

export function mergeQuoteSources(
  codes,
  eastmoneyList,
  tencentList,
  now = Date.now(),
) {
  const eastmoneyByCode = new Map(
    (eastmoneyList || []).map((quote) => [String(quote.code), quote]),
  );
  const tencentByCode = new Map(
    (tencentList || []).map((quote) => [String(quote.code), quote]),
  );
  const today = beijingDayKey(now);
  return (codes || []).map((rawCode) => {
    const code = String(rawCode);
    const eastmoney = eastmoneyByCode.get(code);
    const tencent = tencentByCode.get(code);
    const eastmoneyValid = positive(eastmoney?.price) != null;
    const tencentValid = positive(tencent?.price) != null;
    const eastmoneyCurrent = (
      String(eastmoney?.tradeDate || '').slice(0, 10) === today
    );
    const tencentCurrent = (
      String(tencent?.tradeDate || '').slice(0, 10) === today
    );
    if (eastmoneyValid && eastmoneyCurrent) {
      return {
        ...eastmoney,
        ...quoteDisplayState(eastmoney.tradeDate, now),
      };
    }
    if (tencentValid && tencentCurrent) {
      return withPriceLimitState({
        ...(eastmoney || {}),
        ...tencent,
        code,
        name: eastmoney?.name || tencent.name || '',
        industry: eastmoney?.industry || tencent.industry || null,
        ...quoteDisplayState(tencent.tradeDate, now),
      });
    }
    return previousCloseQuote(code, eastmoney, tencent, now);
  });
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

async function quoteEastmoney(codes) {
  const secids = codes.map(toSecid).join(',');
  // f15 最高 f16 最低 f17 今开 f18 昨收 f100 所属行业
  const fields = 'f2,f3,f4,f8,f10,f12,f14,f62,f84,f184,f6,f15,f16,f17,f18,f100,f124';
  const path =
    `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${encodeURIComponent(secids)}` +
    `&fields=${fields}`;
  const j = await emGet(path);
  const diff = (j && j.data && j.data.diff) || [];
  return diff.map(mapEastmoneyQuote);
}

export async function fetchQuotes(codes, dependencies = {}) {
  const normalizedCodes = (codes || [])
    .map((code) => String(code || '').trim())
    .filter(Boolean);
  if (!normalizedCodes.length) return [];
  const fetchEastmoney = dependencies.fetchEastmoney || quoteEastmoney;
  const fetchTencent = dependencies.fetchTencent || quoteTx;
  const now = Number(dependencies.now) || Date.now();

  let eastmoneyList = [];
  try {
    eastmoneyList = await fetchEastmoney(normalizedCodes);
  } catch { /* 东财失败 → 走腾讯 */ }

  // 东财返回了代码但现价为 0 仍属于缺价，必须继续向腾讯补源。
  const eastmoneyByCode = new Map(
    eastmoneyList.map((quote) => [String(quote.code), quote]),
  );
  const missing = normalizedCodes.filter(
    (code) => positive(eastmoneyByCode.get(code)?.price) == null,
  );
  let tencentList = [];
  if (missing.length) {
    try {
      tencentList = await fetchTencent(missing);
    } catch { /* 腾讯也失败则保持现状 */ }
  }

  return mergeQuoteSources(
    normalizedCodes,
    eastmoneyList,
    tencentList,
    now,
  );
}

export default async function handler(req, res) {
  try {
    const codes = String(req.query.codes || req.query.code || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (codes.length === 0) return sendJson(res, { ok: true, list: [] });

    const list = await fetchQuotes(codes);
    sendJson(res, { ok: true, updatedAt: Date.now(), list }, { cache: 10 });
  } catch (e) {
    sendError(res, e);
  }
}
