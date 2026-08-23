const DATACENTER_URL =
  'https://datacenter-web.eastmoney.com/api/data/v1/get'

function numberOrNull(value) {
  if (value == null || value === '' || value === '-') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function day(value) {
  return String(value || '').slice(0, 10)
}

function toYiFromWan(value) {
  const parsed = numberOrNull(value)
  return parsed == null ? null : +(parsed / 100).toFixed(2)
}

function toYiFromYuan(value) {
  const parsed = numberOrNull(value)
  return parsed == null ? null : +(parsed / 1e8).toFixed(2)
}

export function normalizeNorthboundData({
  history = [],
  topDeals = [],
  updatedAt = Date.now(),
} = {}) {
  const northRows = (Array.isArray(history) ? history : [])
    .filter((item) => ['001', '003', '005'].includes(
      String(item?.MUTUAL_TYPE || ''),
    ))
  const latestDate = northRows
    .map((item) => day(item.TRADE_DATE))
    .filter(Boolean)
    .sort()
    .at(-1) || ''
  const rows = northRows.filter((item) =>
    day(item.TRADE_DATE) === latestDate
  )
  const byType = new Map(
    rows.map((item) => [String(item.MUTUAL_TYPE), item]),
  )
  const total = byType.get('005')
  const sh = byType.get('001')
  const sz = byType.get('003')
  const topStocks = (Array.isArray(topDeals) ? topDeals : [])
    .filter((item) =>
      ['001', '003'].includes(String(item?.MUTUAL_TYPE || ''))
      && day(item.TRADE_DATE) === latestDate
    )
    .sort((left, right) =>
      (numberOrNull(right.DEAL_AMT) || 0)
      - (numberOrNull(left.DEAL_AMT) || 0)
    )
    .slice(0, 10)
    .map((item) => ({
      code: String(item.SECURITY_CODE || '').slice(0, 12),
      name: String(item.SECURITY_NAME || item.SECURITY_CODE || '')
        .slice(0, 40),
      market: String(item.MUTUAL_TYPE) === '001'
        ? '沪股通'
        : '深股通',
      rank: numberOrNull(item.RANK),
      turnoverYi: toYiFromYuan(item.DEAL_AMT),
      pct: numberOrNull(item.CHANGE_RATE),
    }))

  return {
    source: '东方财富互联互通数据',
    date: latestDate,
    updatedAt: Number(updatedAt) || Date.now(),
    totalTurnoverYi: toYiFromWan(total?.DEAL_AMT),
    shTurnoverYi: toYiFromWan(sh?.DEAL_AMT),
    szTurnoverYi: toYiFromWan(sz?.DEAL_AMT),
    dealCount: numberOrNull(total?.DEAL_NUM),
    netBuyYi: null,
    netBuyDisclosure: '未披露',
    topStocks,
  }
}

async function fetchEastmoneyReport(reportName, {
  pageSize,
  fetchImpl,
  timeoutMs,
}) {
  const params = new URLSearchParams({
    source: 'WEB',
    client: 'WEB',
    reportName,
    columns: 'ALL',
    sortColumns: reportName === 'RPT_MUTUAL_TOP10DEAL'
      ? 'TRADE_DATE,RANK'
      : 'TRADE_DATE',
    sortTypes: reportName === 'RPT_MUTUAL_TOP10DEAL' ? '-1,1' : '-1',
    pageSize: String(pageSize),
  })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${DATACENTER_URL}?${params}`, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        Referer: 'https://data.eastmoney.com/hsgt/',
        'User-Agent': 'Mozilla/5.0',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    return payload?.result?.data || []
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchNorthboundData({
  fetchImpl = fetch,
  timeoutMs = 7000,
} = {}) {
  try {
    const [history, topDeals] = await Promise.all([
      fetchEastmoneyReport('RPT_MUTUAL_DEAL_HISTORY', {
        pageSize: 12,
        fetchImpl,
        timeoutMs,
      }),
      fetchEastmoneyReport('RPT_MUTUAL_TOP10DEAL', {
        pageSize: 40,
        fetchImpl,
        timeoutMs,
      }),
    ])
    return normalizeNorthboundData({ history, topDeals })
  } catch {
    return normalizeNorthboundData()
  }
}
