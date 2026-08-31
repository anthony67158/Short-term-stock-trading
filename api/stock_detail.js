import { sendJson, sendError, num } from './_lib.js';
import { computeTechnicals, fetchSelectedQuantPredict } from './_ta.js';
import {
  normalizeQuantModelVersion,
  quantModelLabel,
} from '../shared/modelVersion.js';
import {
  canUseQuantModel,
  resolveQuantModelForRequest,
} from './_quant_access.js';
import {
  fetchResilientStockFund,
} from './_stock_fund.js';
import { fetchQuotes } from './quote.js';
import { isContinuousTrading } from '../shared/tradingCalendar.js';
import {
  buildStockMarketSnapshot,
} from '../shared/stockMarketSnapshot.js';

// secid 前缀：6/9/5 开头沪市=1，其余=0
function toSecid(code) {
  const c = String(code).trim();
  return /^(6|9|5)/.test(c) ? '1.' + c : '0.' + c;
}
function toF10Code(code) {
  const c = String(code).trim();
  return (/^(6|9|5)/.test(c) ? 'SH' : 'SZ') + c;
}

async function jget(url, timeout = 7000, referer = 'https://quote.eastmoney.com/') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: referer,
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 腾讯行情代码：sh600519 / sz000001 / sz300xxx
function toTxCode(code) {
  const c = String(code).trim();
  return (/^(6|9|5)/.test(c) ? 'sh' : 'sz') + c;
}

// ===== 备用数据源：腾讯行情（海外基本不限流，作为东财失败时的兜底）=====
// 注：fetchKlineTx / fetchTrendsTx 同时被 _confirm.js(智能确认闸门)复用为盘中/日线数据源,
//   故一并 export;二者只读腾讯公开行情,不触碰量化 /predict(36维OHLCV模型)口径。
// 日/周/月 K线
export async function fetchKlineTx(code, klt, lmt) {
  const tx = toTxCode(code);
  const period = klt === '102' ? 'week' : klt === '103' ? 'month' : 'day';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tx},${period},,,${lmt},qfq&_=${Date.now()}`;
  const j = await jget(url, 6000, 'https://gu.qq.com/');
  const node = j && j.data && j.data[tx];
  if (!node) return null;
  // 前复权优先：qfqday / qfqweek / qfqmonth，回退非复权 day/week/month
  const rows = node['qfq' + period] || node[period] || [];
  if (!rows.length) return null;
  // 腾讯每行：[日期, 开, 收, 高, 低, 成交量(手), {...或成交额}]
  const candles = rows.map((r) => {
    const open = num(r[1]), close = num(r[2]), high = num(r[3]), low = num(r[4]);
    return {
      date: r[0], open, close, high, low,
      volume: num(r[5]),
      amount: num(r[6] && typeof r[6] === 'object' ? 0 : r[6]) || 0,
      pct: 0, // 腾讯不直接给涨跌幅，前端/下方补算
    };
  });
  // 用前收补算涨跌幅
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev) candles[i].pct = +(((candles[i].close - prev) / prev) * 100).toFixed(2);
  }
  return { name: (node.qt && node.qt[tx] && node.qt[tx][1]) || '', candles };
}

// 当日分时（腾讯）
export async function fetchTrendsTx(code) {
  const tx = toTxCode(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tx}&_=${Date.now()}`;
  const j = await jget(url, 5000, 'https://gu.qq.com/');
  const root = j && j.data && j.data[tx];
  const node = root && root.data;
  if (!node || !Array.isArray(node.data) || !node.data.length) return null;
  // 昨收在 qt[tx][4]（qt 是 data 的兄弟节点）
  const preClose = num(root.qt && root.qt[tx] && root.qt[tx][4]);
  // 每行 "HHMM 价格 累计量(手) 累计成交额(元)"。均价=累计额/(累计量×100)，每分钟量=累计量差分
  let prevCum = 0;
  const trends = node.data.map((line) => {
    const p = String(line).split(/\s+/);
    const hhmm = p[0];
    const time = /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
    const price = num(p[1]);
    const cumVol = num(p[2]);           // 累计成交量(手)
    const cumAmt = num(p[3]);           // 累计成交额(元)
    const vwap = cumVol ? +(cumAmt / (cumVol * 100)).toFixed(2) : price; // 真·均价 VWAP
    const vol = Math.max(cumVol - prevCum, 0); // 每分钟量
    prevCum = cumVol;
    return { time, price, volume: vol, avg: vwap };
  });
  return { trends, preClose };
}

const KLINE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://82.push2his.eastmoney.com',
  'https://45.push2his.eastmoney.com',
  'https://49.push2his.eastmoney.com',
];
export const KLINE_FRESH_CACHE_MS = 2 * 60 * 1000;
const KLINE_STALE_CACHE_MS = 24 * 60 * 60 * 1000;

function normalizeKlineResult(result, source) {
  const candles = Array.isArray(result?.candles)
    ? result.candles.filter((item) => (
        item
        && Number(item.open) > 0
        && Number(item.close) > 0
        && Number(item.high) > 0
        && Number(item.low) > 0
      ))
    : [];
  if (!candles.length) throw new Error(`empty ${source} klines`);
  return {
    name: String(result?.name || ''),
    candles,
    source,
    stale: false,
  };
}

function firstUsableKline(sources, {
  code,
  klt,
  sourceLimit,
  preferredCount,
}) {
  return new Promise((resolve, reject) => {
    let pending = sources.length;
    let settled = false;
    let best = null;
    const errors = [];
    const finish = () => {
      pending -= 1;
      if (pending > 0 || settled) return;
      settled = true;
      if (best) resolve(best);
      else reject(new AggregateError(errors, 'all kline sources failed'));
    };
    for (const [source, fetchSource] of sources) {
      Promise.resolve()
        .then(() => fetchSource(code, klt, sourceLimit))
        .then((result) => normalizeKlineResult(result, source))
        .then((result) => {
          if (
            !best
            || result.candles.length > best.candles.length
          ) {
            best = result;
          }
          if (
            !settled
            && result.candles.length >= preferredCount
          ) {
            settled = true;
            resolve(result);
          }
        })
        .catch((error) => errors.push(error))
        .finally(finish);
    }
  });
}

export async function fetchKlineEastmoney(code, klt, lmt) {
  const path =
    `/api/qt/stock/kline/get?secid=${toSecid(code)}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f61` +
    `&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;
  const payload = await Promise.any(KLINE_HOSTS.map((host) => (
    jget(host + path, 5000).then((json) => {
      if (!Array.isArray(json?.data?.klines) || !json.data.klines.length) {
        throw new Error('empty eastmoney klines');
      }
      return json;
    })
  )));
  const data = payload.data;
  return {
    name: data?.name || '',
    candles: data.klines.map((line) => {
      const parts = line.split(',');
      return {
        date: parts[0],
        open: num(parts[1]),
        close: num(parts[2]),
        high: num(parts[3]),
        low: num(parts[4]),
        volume: num(parts[5]),
        amount: num(parts[6]),
        pct: num(parts[8]),
        turnover: num(parts[9]) || null,
      };
    }),
  };
}

export async function fetchKlineSina(code, klt, lmt) {
  if (String(klt) !== '101') return null;
  const symbol = toTxCode(code);
  const url =
    'https://quotes.sina.cn/cn/api/openapi.php/' +
    'CN_MarketDataService.getKLineData' +
    `?symbol=${symbol}&scale=240&ma=no&datalen=${lmt}`;
  const payload = await jget(url, 6000, 'https://finance.sina.com.cn/');
  if (Number(payload?.result?.status?.code) !== 0) return null;
  const rows = Array.isArray(payload?.result?.data)
    ? payload.result.data
    : [];
  const candles = rows.map((row) => ({
    date: String(row.day || ''),
    open: num(row.open),
    close: num(row.close),
    high: num(row.high),
    low: num(row.low),
    volume: num(row.volume),
    amount: num(row.amount),
    pct: 0,
    turnover: null,
  })).sort((a, b) => a.date.localeCompare(b.date));
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close;
    if (previous > 0) {
      candles[index].pct = +(
        ((candles[index].close - previous) / previous) * 100
      ).toFixed(2);
    }
  }
  return { name: '', candles };
}

export function createResilientKlineFetcher({
  fetchTencent = fetchKlineTx,
  fetchEastmoney = fetchKlineEastmoney,
  fetchSina = fetchKlineSina,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const flights = new Map();
  const trim = (result, limit, stale = false) => ({
    ...result,
    stale,
    candles: result.candles.slice(-limit),
  });
  return async (code, klt = '101', lmt = 120) => {
    const limit = Math.max(1, Math.min(Number(lmt) || 120, 500));
    const sourceLimit = limit <= 200 ? 200 : 500;
    const preferredCount = sourceLimit;
    const key = `${String(code)}:${String(klt)}:${sourceLimit}`;
    const timestamp = Number(now()) || Date.now();
    const cached = cache.get(key);
    if (cached && timestamp - cached.at <= KLINE_FRESH_CACHE_MS) {
      return trim(cached.value, limit);
    }
    if (!flights.has(key)) {
      const attempt = async () => {
        const sources = [
          ['tencent', fetchTencent],
          ['eastmoney', fetchEastmoney],
        ];
        if (String(klt) === '101') sources.push(['sina', fetchSina]);
        return firstUsableKline(sources, {
          code,
          klt,
          sourceLimit,
          preferredCount,
        });
      };
      const flight = attempt()
        .catch(() => new Promise((resolve) => setTimeout(resolve, 120))
          .then(attempt))
        .then((value) => {
          const fetchedAt = Number(now()) || Date.now();
          const freshValue = { ...value, fetchedAt };
          cache.set(key, { at: fetchedAt, value: freshValue });
          while (cache.size > 128) cache.delete(cache.keys().next().value);
          return freshValue;
        })
        .finally(() => {
          if (flights.get(key) === flight) flights.delete(key);
        });
      flights.set(key, flight);
    }
    try {
      return trim(await flights.get(key), limit);
    } catch {
      if (
        cached
        && timestamp - cached.at <= KLINE_STALE_CACHE_MS
      ) {
        return trim(cached.value, limit, true);
      }
      return null;
    }
  };
}

export const fetchResilientKline = createResilientKlineFetcher();

// 个股详情：公司简介(主营) + 日K线 + (可选)当日分时
// query: code=600519  klt=101(日)|102(周)|103(月)  lmt=K线根数  trends=1(附当日分时)
export default async function handler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return sendJson(res, { ok: false, error: 'missing code' });
    const klt = req.query.klt || '101';
    const lmt = Math.min(Number(req.query.lmt) || 120, 500);
    const wantTrends = req.query.trends === '1';
    const wantQuote = req.query.quote === '1';
    const wantQuant = req.query.quant === '1';
    const requestedAt = Date.now();
    const quantModelVersion = wantQuant
      ? await resolveQuantModelForRequest(req, req.query.model)
      : normalizeQuantModelVersion(req.query.model);
    if (
      wantQuant
      && !(await canUseQuantModel(req, quantModelVersion))
    ) {
      return sendJson(res, {
        ok: false,
        error: `${quantModelLabel(quantModelVersion)}需要已登录且当前账号已选择该版本`,
      }, { cache: 0 });
    }
    const secid = toSecid(code);

    // 当日分时（trends2：f51时间,f53现价,f56量,f58均价）
    const trendsPath =
      `/api/qt/stock/trends2/get?secid=${secid}` +
      `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f17` +
      `&fields2=f51,f53,f56,f58&iscr=0&ndays=1&forcect=1`;

    // 公司简介
    const f10Url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${toF10Code(code)}`;

    // 分时多镜像：push2 实时 + push2his 历史，并发取先返回且有数据的（超时压到4s，绝不拖垮K线）
    const trendsHosts = ['https://push2.eastmoney.com', 'https://push2his.eastmoney.com'];
    async function fetchTrends() {
      const race = trendsHosts.map((h) => jget(h + trendsPath, 4000).then((j) => {
        if (j && j.data && Array.isArray(j.data.trends) && j.data.trends.length) return j;
        throw new Error('empty trends');
      }));
      try { return await Promise.any(race); } catch { return null; }
    }

    // 用 allSettled 保证：分时/简介失败绝不影响 K线返回
    const [klRes, f10Res, trendsRes, quoteRes, fundRes] =
      await Promise.allSettled([
        fetchResilientKline(code, klt, lmt),
        jget(f10Url, 6000, 'https://emweb.securities.eastmoney.com/'),
        wantTrends ? fetchTrends() : Promise.resolve(null),
        wantQuote
          ? fetchQuotes([code], { now: requestedAt })
          : Promise.resolve([]),
        wantQuote
          ? fetchResilientStockFund(code, {
              preferRealtime: isContinuousTrading(requestedAt),
              fetchedAt: requestedAt,
            })
          : Promise.resolve(null),
      ]);
    const kline = klRes.status === 'fulfilled' ? klRes.value : null;
    const f10Json = f10Res.status === 'fulfilled' ? f10Res.value : null;
    const trendsJson = trendsRes.status === 'fulfilled' ? trendsRes.value : null;
    const quote = quoteRes.status === 'fulfilled'
      ? quoteRes.value.find((item) => item.code === String(code)) || null
      : null;
    const fund = fundRes.status === 'fulfilled' ? fundRes.value : null;

    const candles = Array.isArray(kline?.candles)
      ? kline.candles
      : [];
    if (!candles.length) {
      return sendJson(res, {
        ok: false,
        error: '行情数据暂时不可用，请稍后重试',
        errorCode: 'KLINE_UNAVAILABLE',
      }, { cache: 0 });
    }

    // 解析分时（f51时间,f53现价,f56量,f58均价）；东财空则回退腾讯
    let trends = null, preClose = null;
    if (wantTrends && trendsJson && trendsJson.data && Array.isArray(trendsJson.data.trends) && trendsJson.data.trends.length) {
      preClose = num(trendsJson.data.preClose);
      trends = trendsJson.data.trends.map((line) => {
        const p = line.split(',');
        return { time: p[0], price: num(p[1]), volume: num(p[2]), avg: num(p[3]) };
      });
    } else if (wantTrends) {
      try {
        const tx = await fetchTrendsTx(code);
        if (tx && tx.trends && tx.trends.length) { trends = tx.trends; preClose = tx.preClose; }
      } catch { /* 忽略 */ }
    }

    // 解析简介
    const jb = (f10Json && f10Json.jbzl && f10Json.jbzl[0]) || {};
    const profile = {
      fullName: jb.ORG_NAME || kline?.name || '',
      name: jb.SECURITY_NAME_ABBR || kline?.name || '',
      code: jb.SECURITY_CODE || code,
      industry: jb.EM2016 || jb.INDUSTRYCSRC1 || '',
      market: jb.SECURITY_TYPE || '',
      business: jb.BUSINESS_SCOPE || '',
      intro: (jb.ORG_PROFILE || '').trim(),
      website: jb.ORG_WEB || '',
      empNum: jb.EMP_NUM || '',
    };

    // 专业技术指标（ATR/布林/RSI/KDJ/MACD/量能 + 买卖价位建议 + 大白话）
    const periodLabel = klt === '102' ? '周' : klt === '103' ? '月' : '日';
    let tech = null;
    try { tech = computeTechnicals(candles, periodLabel); } catch { /* 指标失败不阻断 */ }
    const marketSnapshot = wantQuote
      ? buildStockMarketSnapshot({ quote, candles, fund })
      : null;

    // 量化预测（quant=1 时调用；把本地已取到的 K线传给量化服务，绕开其取数被风控）
    // 可选持仓：holdCost 传入则给"加/减/做T"建议，否则给"买/观望"建议
    let quant = null;
    let quantError = '';
    if (wantQuant && candles.length >= 25) {
      const holdCost = Number(req.query.holdCost) || null;
      const hold = holdCost ? { cost: holdCost, qty: Number(req.query.holdQty) || null } : null;
      try {
        quant = await fetchSelectedQuantPredict(
          quantModelVersion,
          code,
          candles,
          hold,
          20000,
        )
      } catch (error) {
        quantError = String(error?.message || error || '')
      }
    }
    if (
      wantQuant
      && quantModelVersion !== 'default'
      && !quant
    ) {
      return sendJson(res, {
        ok: false,
        error: quantError
          || `${quantModelLabel(quantModelVersion)}服务未运行或预测不可用`,
        quantModelVersion,
      }, { cache: 0 })
    }

    // 缓存策略：带量化请求时，拿到 quant 才短缓存(60s)，没拿到不缓存(下次可重试冷启动后的服务)
    const cacheSec = wantQuant ? (quant ? 60 : 0) : (candles.length ? 120 : 0);
    sendJson(
      res,
      {
        ok: true,
        code,
        updatedAt: Date.now(),
        profile,
        klt,
        candles,
        klineSource: kline?.source || null,
        klineStale: kline?.stale === true,
        trends,
        preClose,
        quote,
        fund,
        marketSnapshot,
        tech,
        quant,
        quantModelVersion,
      },
      { cache: cacheSec }
    );
  } catch (e) {
    sendError(res, e);
  }
}
