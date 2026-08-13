const HOST = 'https://push2ex.eastmoney.com'
const UT = '7eea3edcaed734bea9cbfc24409ed989'

const CONFIG = {
  zt: { endpoint: 'getTopicZTPool', sort: 'fbt:asc' },
  dt: { endpoint: 'getTopicDTPool', sort: 'fund:desc' },
  zb: { endpoint: 'getTopicZBPool', sort: 'zbc:desc' },
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function limitPoolDay(now = Date.now()) {
  const date = new Date(now + 8 * 3600000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

export function limitPoolRequest(kind = 'zt', date = limitPoolDay(), now = Date.now()) {
  const config = CONFIG[kind] || CONFIG.zt
  return `/${config.endpoint}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=200`
    + `&sort=${encodeURIComponent(config.sort)}&date=${encodeURIComponent(date)}&_=${now}`
}

export function normalizeLimitPool(kind, payload) {
  const data = payload?.data || {}
  const pool = Array.isArray(data.pool) ? data.pool : []
  const list = pool.map((item) => ({
    code: item.c,
    name: item.n,
    pct: finite(item.zdp),
    price: finite(item.p) != null ? finite(item.p) / 1000 : null,
    limitTimes: finite(item.zttj?.days) || finite(item.days) || 0,
    boardCount: finite(item.zttj?.ct) || 0,
    lbc: finite(item.lbc) || 0,
    fundAmount: finite(item.fund),
    firstTime: item.fbt,
    lastTime: item.lbt,
    breakTimes: finite(item.zbc) || 0,
    turnover: finite(item.hs),
    sector: item.hybk,
    amount: finite(item.amount),
  }))
  const reportedTotal = finite(data.tc)
  return {
    kind,
    date: String(data.qdate || ''),
    total: reportedTotal != null ? reportedTotal : list.length,
    list,
  }
}

export async function fetchLimitPool(
  kind = 'zt',
  date = limitPoolDay(),
  { timeout = 7000, now = Date.now() } = {},
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(HOST + limitPoolRequest(kind, date, now), {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        Referer: 'https://quote.eastmoney.com/',
        Accept: '*/*',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return normalizeLimitPool(kind, await response.json())
  } finally {
    clearTimeout(timer)
  }
}
