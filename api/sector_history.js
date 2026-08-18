import {
  emGet,
  emGetAll,
  emGetFirstValid,
  sendJson,
  sendError,
} from './_lib.js';
import { put, readJson } from './_blob.js';
import {
  parseSectorFlowRows,
  selectLongestKlines,
} from '../shared/sectorFlowHistory.js';
import {
  buildConceptTrendSummary,
  parseConceptCloseHistoryPayload,
  parseConceptKlinePayload,
  parseConceptTrendPayload,
  selectLongestConceptKlinePayload,
} from '../shared/conceptTrend.js';

const KLINE_PERIODS = {
  day: { period: 'day', klt: 101, limit: 120 },
  week: { period: 'week', klt: 102, limit: 104 },
  month: { period: 'month', klt: 103, limit: 60 },
};
const CONCEPT_HISTORY_PREFIX = 'market/concept-history/';

export function conceptKlinePeriod(value) {
  return KLINE_PERIODS[value] || KLINE_PERIODS.day;
}

export async function fetchLongestKlinePayload(path, {
  fetchAllImpl = emGetAll,
  referer,
  rounds = 2,
  minRows = 2,
  includeRealtime = false,
} = {}) {
  const candidates = [];
  for (let round = 0; round < rounds; round++) {
    candidates.push(
      ...await fetchAllImpl(path, { his: true, referer }),
    );
    const longest = selectLongestConceptKlinePayload(candidates);
    if ((longest?.data?.klines?.length || 0) >= minRows) return longest;
  }
  if (includeRealtime) {
    candidates.push(...await fetchAllImpl(path, { referer }));
  }
  return selectLongestConceptKlinePayload(candidates);
}

export async function resolveConceptHistoryResponse(response, {
  readCache = (key) => readJson(key),
  writeCache = (key, value) => put(
    key,
    JSON.stringify(value),
    {
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    },
  ),
} = {}) {
  const code = /^BK\d{4}$/.test(String(response?.code || ''))
    ? response.code
    : 'unknown';
  const period = KLINE_PERIODS[response?.period]
    ? response.period
    : 'day';
  const key = `${CONCEPT_HISTORY_PREFIX}${code}/${period}.json`;
  if ((response?.points?.length || 0) >= 2) {
    const live = { ...response, cacheState: 'live' };
    let cacheStored = false;
    try {
      await writeCache(key, live);
      cacheStored = true;
    } catch { /* 实时数据仍可返回，后续请求继续尝试写缓存 */ }
    return { ...live, cacheStored };
  }
  const cached = await readCache(key).catch(() => null);
  if ((cached?.points?.length || 0) >= 2) {
    return { ...cached, cacheState: 'cached', cacheStored: true };
  }
  return { ...response, cacheState: 'miss', cacheStored: false };
}

export function conceptIntradayFromPayload(
  payload,
  fallbackCode = '',
  now = Date.now(),
) {
  const parsed = parseConceptTrendPayload(payload, fallbackCode);
  return {
    ok: true,
    mode: 'intraday',
    code: parsed.code,
    name: parsed.name,
    preClose: parsed.preClose,
    tradingDate: parsed.tradingDate,
    updatedAt: now,
    source: '东方财富概念板块行情',
    points: parsed.points,
    summary: buildConceptTrendSummary(parsed.points, parsed.preClose),
  };
}

export function conceptKlineFromPayload(
  payload,
  fallbackCode = '',
  period = 'day',
  now = Date.now(),
) {
  const parsed = parseConceptKlinePayload(payload, fallbackCode, period);
  return {
    ok: true,
    mode: 'kline',
    format: 'candlestick',
    period: parsed.period,
    code: parsed.code,
    name: parsed.name,
    updatedAt: now,
    source: '东方财富概念板块历史行情',
    points: parsed.points,
    summary: parsed.summary,
  };
}

export function conceptCloseHistoryFromPayload(
  payload,
  fallbackCode = '',
  period = 'day',
  now = Date.now(),
) {
  const parsed = parseConceptCloseHistoryPayload(
    payload,
    fallbackCode,
    period,
  );
  return {
    ok: true,
    mode: 'kline',
    format: parsed.format,
    period: parsed.period,
    code: parsed.code,
    name: parsed.name,
    updatedAt: now,
    source: '东方财富概念板块历史收盘与资金行情',
    points: parsed.points,
    summary: parsed.summary,
  };
}

// 板块资金流历史趋势（近N日主力净流入）
// query: code=BKxxxx  days=10
export default async function handler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return sendJson(res, { ok: false, error: 'missing code' });
    if (!/^BK\d{4}$/.test(code)) return sendJson(res, { ok: false, error: 'invalid code' });
    if (req.query.mode === 'intraday') {
      const path =
        `/api/qt/stock/trends2/get?secid=90.${code}`
        + `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13`
        + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
        + `&ndays=1&iscr=0&_=${Date.now()}`;
      const historical = await emGet(path, { his: true }).catch(() => null);
      const payload = historical?.data?.trends?.length
        ? historical
        : await emGet(path).catch(() => null);
      return sendJson(
        res,
        conceptIntradayFromPayload(payload, code),
        { cache: 20 },
      );
    }
    if (req.query.mode === 'kline') {
      const config = conceptKlinePeriod(req.query.period);
      const requestId = Date.now();
      const path =
        `/api/qt/stock/kline/get?cb=conceptKline${requestId}&secid=90.${code}`
        + `&ut=fa5fd1943c7b386f172d6893dbfba10b`
        + `&klt=${config.klt}&fqt=1&beg=0&end=20500101`
        + `&smplmt=460&lmt=1000000`
        + `&fields1=f1,f2,f3,f4,f5,f6`
        + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`
        + `&_=${requestId}`;
      const referer = 'https://quote.eastmoney.com/';
      const validHistory = (candidate) =>
        (candidate?.data?.klines?.length || 0) >= 2;
      const payload = await emGetFirstValid(path, {
        his: true,
        referer,
        accept: validHistory,
      }) || await emGetFirstValid(path, {
        referer,
        accept: validHistory,
      });
      const limitedPayload = payload?.data
        ? {
            ...payload,
            data: {
              ...payload.data,
              klines: (payload.data.klines || []).slice(-config.limit),
            },
          }
        : payload;
      let response = conceptKlineFromPayload(
        limitedPayload,
        code,
        config.period,
      );
      if (!response.points.length) {
        const flowPath =
          `/api/qt/stock/fflow/daykline/get?lmt=250&klt=101`
          + `&ut=b2884a393a59ad64002292a3e90d46a5`
          + `&fields1=f1,f2,f3,f7`
          + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`
          + `&secid=90.${code}&_=${requestId}`;
        const flowPayload = await emGetFirstValid(flowPath, {
          his: true,
          accept: validHistory,
        }) || await emGetFirstValid(flowPath, {
          accept: validHistory,
        });
        response = conceptCloseHistoryFromPayload(
          flowPayload,
          code,
          config.period,
        );
      }
      const resolved = await resolveConceptHistoryResponse(response);
      return sendJson(res, resolved, {
        cache: resolved.points.length >= 2 ? 300 : 0,
      });
    }
    const days = Math.max(1, Math.min(Number(req.query.days) || 10, 30));

    // 板块历史资金流：日线必须优先走 push2his；push2 同路径通常只返回当天一条。
    const path =
      `/api/qt/stock/fflow/daykline/get?lmt=${days}&klt=101` +
      `&ut=b2884a393a59ad64002292a3e90d46a5` +
      `&fields1=f1,f2,f3,f7` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65` +
      `&secid=90.${code}&_=${Date.now()}`;

    const historical = await emGet(path, { his: true }).catch(() => null);
    const candidates = [historical];
    if (selectLongestKlines(candidates).length === 0) {
      candidates.push(await emGet(path).catch(() => null));
    }
    const series = parseSectorFlowRows(selectLongestKlines(candidates), days);

    sendJson(res, {
      ok: true,
      code,
      updatedAt: Date.now(),
      sampleDays: series.length,
      series,
    }, { cache: 300 });
  } catch (e) {
    sendError(res, e);
  }
}
