import { buildRetailFlowEvidence } from '../shared/retailFundFlow.js';

const HISTORY_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://82.push2his.eastmoney.com',
  'https://45.push2his.eastmoney.com',
  'https://49.push2his.eastmoney.com',
  'https://28.push2his.eastmoney.com',
  'https://33.push2his.eastmoney.com',
  'https://48.push2his.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
];

const REALTIME_HOSTS = [
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
];

const optionalNumber = (value) => {
  if (value == null || value === '' || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const fundAmountYi = (value) => {
  const number = optionalNumber(value);
  return number == null ? null : +(number / 1e8).toFixed(2);
};

export const fundPct = (value) => {
  const number = optionalNumber(value);
  return number == null ? null : +number.toFixed(2);
};

function toSecid(code) {
  const value = String(code || '').trim();
  if (!/^\d{6}$/.test(value)) return '';
  return /^(6|9|5)/.test(value) ? `1.${value}` : `0.${value}`;
}

function beijingDay(timestamp = Date.now()) {
  return new Date(Number(timestamp) + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function sum(values) {
  const usable = values.filter((value) => value != null);
  return usable.length
    ? +usable.reduce((total, value) => total + value, 0).toFixed(2)
    : null;
}

function streak(values = []) {
  let result = 0;
  for (let index = values.length - 1; index >= 0; index--) {
    const value = optionalNumber(values[index]);
    if (value == null || value === 0) break;
    if (result === 0) result = value > 0 ? 1 : -1;
    else if ((result > 0 && value > 0) || (result < 0 && value < 0)) {
      result += result > 0 ? 1 : -1;
    } else break;
  }
  return result || null;
}

export function mapRealtimeStockFund(data = {}) {
  return {
    mainNetYi: fundAmountYi(data.f62),
    mainNetPct: fundPct(data.f184),
    superNetYi: fundAmountYi(data.f66),
    bigNetYi: fundAmountYi(data.f72),
    smallNetYi: fundAmountYi(data.f84),
    retailNetYi: fundAmountYi(data.f84),
    main5dYi: fundAmountYi(data.f164),
    weibi: fundPct(data.f191),
    weicha: optionalNumber(data.f192) == null
      ? null
      : Math.round(Number(data.f192)),
  };
}

export function parseStockFundHistory(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => {
      const parts = String(line || '').split(',');
      const date = String(parts[0] || '').slice(0, 10);
      if (!date) return null;
      return {
        date,
        mainNetYi: fundAmountYi(parts[1]),
        retailNetYi: fundAmountYi(parts[2]),
        midNetYi: fundAmountYi(parts[3]),
        bigNetYi: fundAmountYi(parts[4]),
        superNetYi: fundAmountYi(parts[5]),
        mainNetPct: fundPct(parts[6]),
      };
    })
    .filter(Boolean)
    .slice(-8);
}

export function buildStockFundSnapshot({
  historyRows = [],
  realtime = null,
  preferRealtime = false,
  fetchedAt = Date.now(),
} = {}) {
  const history = (Array.isArray(historyRows) ? historyRows : [])
    .filter((item) => item?.date)
    .slice(-5);
  const latest = history.at(-1) || {};
  const hasRealtime = !!(
    realtime
    && [realtime.mainNetYi, realtime.retailNetYi]
      .some((value) => value != null)
  );
  const useRealtime = preferRealtime && hasRealtime;
  if (!history.length && !hasRealtime) return null;

  const mainTrend5 = history.map((item) =>
    optionalNumber(item.mainNetYi)
  );
  const retailTrend5 = history.map((item) =>
    optionalNumber(item.retailNetYi)
  );
  const historyDayCount = history.length;
  const historyComplete = historyDayCount >= 5;
  const mainHistoryTotal = sum(mainTrend5);
  const retailHistoryTotal = sum(retailTrend5);
  const main5dYi = historyComplete
    ? mainHistoryTotal
    : optionalNumber(realtime?.main5dYi);
  const retail5dYi = historyComplete
    ? retailHistoryTotal
    : null;
  const mainNetYi = useRealtime
    ? optionalNumber(realtime.mainNetYi)
    : optionalNumber(latest.mainNetYi ?? realtime?.mainNetYi);
  const retailNetYi = useRealtime
    ? optionalNumber(realtime.retailNetYi)
    : optionalNumber(latest.retailNetYi ?? realtime?.retailNetYi);
  const asOfDate = useRealtime
    ? beijingDay(fetchedAt)
    : latest.date || null;
  const snapshot = {
    schemaVersion: 'stock-fund-snapshot.v1',
    fetchedAt: Number(fetchedAt) || Date.now(),
    source: useRealtime ? 'realtime' : 'historical',
    asOfDate,
    historicalAsOfDate: latest.date || null,
    isHistorical: !useRealtime,
    mainNetYi,
    mainNetPct: useRealtime
      ? optionalNumber(realtime.mainNetPct)
      : optionalNumber(latest.mainNetPct ?? realtime?.mainNetPct),
    retailNetYi,
    smallNetYi: retailNetYi,
    superNetYi: useRealtime
      ? optionalNumber(realtime.superNetYi)
      : optionalNumber(latest.superNetYi ?? realtime?.superNetYi),
    bigNetYi: useRealtime
      ? optionalNumber(realtime.bigNetYi)
      : optionalNumber(latest.bigNetYi ?? realtime?.bigNetYi),
    midNetYi: optionalNumber(latest.midNetYi),
    main5dYi,
    main5dAvgYi: historyComplete && mainHistoryTotal != null
      ? +(mainHistoryTotal / historyDayCount).toFixed(2)
      : null,
    retail5dYi,
    retail5dAvgYi: historyComplete && retailHistoryTotal != null
      ? +(retailHistoryTotal / historyDayCount).toFixed(2)
      : null,
    historyDayCount,
    historyComplete,
    trend5: mainTrend5,
    mainTrend5,
    retailTrend5,
    history5: history,
    inflowDays: mainTrend5.filter((value) => value > 0).length,
    retailInflowDays: retailTrend5.filter((value) => value > 0).length,
    mainStreak: streak(mainTrend5),
    retailStreak: streak(retailTrend5),
    weibi: optionalNumber(realtime?.weibi),
    weicha: optionalNumber(realtime?.weicha),
  };
  snapshot.retailFlow = buildRetailFlowEvidence(snapshot);
  return snapshot;
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://data.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!response?.ok) throw new Error(`HTTP_${response?.status || 0}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function firstValid(hosts, path, {
  fetchImpl,
  timeoutMs,
  pick,
}) {
  try {
    return await Promise.any(hosts.map(async (host) => {
      const payload = await fetchJson(fetchImpl, host + path, timeoutMs);
      const value = pick(payload);
      if (value == null) throw new Error('empty');
      return value;
    }));
  } catch {
    return null;
  }
}

async function bestValid(hosts, path, {
  fetchImpl,
  timeoutMs,
  pick,
  score = (value) =>
    Array.isArray(value) ? value.length : value == null ? 0 : 1,
}) {
  const settled = await Promise.all(hosts.map(async (host) => {
    try {
      const payload = await fetchJson(fetchImpl, host + path, timeoutMs);
      return pick(payload);
    } catch {
      return null;
    }
  }));
  return settled.reduce((best, value) =>
    value != null && score(value) > score(best)
      ? value
      : best
  , null);
}

export async function fetchStockFund(code, {
  fetchImpl = fetch,
  historyLimit = 8,
  timeoutMs = 3000,
  preferRealtime = false,
  fetchedAt = Date.now(),
} = {}) {
  const secid = toSecid(code);
  if (!secid) return null;
  const historyPath =
    `/api/qt/stock/fflow/daykline/get?lmt=${historyLimit}&klt=101`
    + `&secid=${secid}&ut=b2884a393a59ad64002292a3e90d46a5`
    + '&fields1=f1,f2,f3,f7'
    + '&fields2=f51,f52,f53,f54,f55,f56,f57';
  const realtimePath =
    `/api/qt/stock/get?secid=${secid}`
    + '&fields=f62,f84,f184,f66,f72,f164,f191,f192';
  const [historyLines, realtime] = await Promise.all([
    bestValid(HISTORY_HOSTS, historyPath, {
      fetchImpl,
      timeoutMs,
      pick: (payload) => {
        const lines = payload?.data?.klines;
        return Array.isArray(lines) && lines.length ? lines : null;
      },
      score: (lines) => Array.isArray(lines) ? lines.length : 0,
    }),
    firstValid(REALTIME_HOSTS, realtimePath, {
      fetchImpl,
      timeoutMs,
      pick: (payload) => payload?.data || null,
    }),
  ]);
  return buildStockFundSnapshot({
    historyRows: parseStockFundHistory(historyLines || []),
    realtime: realtime ? mapRealtimeStockFund(realtime) : null,
    preferRealtime,
    fetchedAt,
  });
}
