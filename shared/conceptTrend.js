function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null
}

function formatNumber(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return number.toFixed(digits).replace(/\.?0+$/, '')
}

function formatAmount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  if (Math.abs(number) >= 1e8) return `${(number / 1e8).toFixed(2)}亿`
  if (Math.abs(number) >= 1e4) return `${(number / 1e4).toFixed(2)}万`
  return formatNumber(number)
}

export function filterConceptSectors(sectors, query = '') {
  const list = (Array.isArray(sectors) ? sectors : [])
    .filter((item) => /^BK\d{4}$/.test(String(item?.code || '')))
  const keyword = String(query || '').trim().toLocaleLowerCase('zh-CN')
  if (!keyword) return list
  return list.filter((item) =>
    String(item?.name || '').toLocaleLowerCase('zh-CN').includes(keyword)
    || String(item?.code || '').toLocaleLowerCase('zh-CN').includes(keyword)
  )
}

export function parseConceptTrendRows(rows, preClose) {
  const base = finite(preClose)
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const parts = String(row || '').split(',')
    const at = String(parts[0] || '').trim()
    const match = at.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/)
    const price = finite(parts[2])
    if (!match || price == null || price <= 0) return []
    const avg = finite(parts[7])
    const volume = finite(parts[5])
    const amount = finite(parts[6])
    return [{
      at,
      time: match[2],
      price,
      avg,
      pct: base > 0 ? round((price / base - 1) * 100) : null,
      avgPct: base > 0 && avg != null
        ? round((avg / base - 1) * 100)
        : null,
      volume,
      amount,
    }]
  })
}

export function parseConceptTrendPayload(payload, fallbackCode = '') {
  const data = payload?.data || {}
  const preClose = finite(data.preClose)
  const points = parseConceptTrendRows(data.trends, preClose)
  return {
    code: String(data.code || fallbackCode || '').trim(),
    name: String(data.name || '').trim(),
    preClose,
    tradingDate: points[0]?.at?.slice(0, 10) || '',
    points,
  }
}

export function buildConceptTrendSummary(points, preClose) {
  const rows = (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(Number(point?.price)))
  if (!rows.length) return null
  const prices = rows.map((point) => Number(point.price))
  const latestPoint = rows.at(-1)
  const latest = Number(latestPoint.price)
  const base = finite(preClose)
  const high = Math.max(...prices)
  const low = Math.min(...prices)
  const sum = (field) => {
    const values = rows
      .map((point) => finite(point?.[field]))
      .filter((value) => value != null)
    return values.length ? values.reduce((total, value) => total + value, 0) : null
  }
  return {
    latest,
    pct: base > 0 ? round((latest / base - 1) * 100) : null,
    high,
    low,
    amplitude: base > 0 ? round((high - low) / base * 100) : null,
    volume: sum('volume'),
    amount: sum('amount'),
    lastTime: latestPoint.time || '',
  }
}

export function parseConceptKlineRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const fields = String(row || '').split(',')
    const date = String(fields[0] || '').trim()
    const open = finite(fields[1])
    const close = finite(fields[2])
    const high = finite(fields[3])
    const low = finite(fields[4])
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || [open, close, high, low].some((value) => value == null)
    ) {
      return []
    }
    return [{
      date,
      open,
      close,
      high,
      low,
      volume: finite(fields[5]),
      amount: finite(fields[6]),
      amplitude: finite(fields[7]),
      pct: finite(fields[8]),
      change: finite(fields[9]),
      turnover: finite(fields[10]),
    }]
  })
}

function closeHistoryGroupKey(date, period) {
  if (period === 'month') return date.slice(0, 7)
  if (period !== 'week') return date
  const value = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(value.getTime())) return date
  const offset = (value.getUTCDay() + 6) % 7
  value.setUTCDate(value.getUTCDate() - offset)
  return value.toISOString().slice(0, 10)
}

function aggregateCloseHistory(points, period) {
  if (period === 'day') return points.slice(-120)
  const groups = new Map()
  for (const point of points) {
    const key = closeHistoryGroupKey(point.date, period)
    const group = groups.get(key) || []
    group.push(point)
    groups.set(key, group)
  }
  const limit = period === 'week' ? 104 : 60
  const aggregated = [...groups.values()].map((group) => {
    const latest = group.at(-1)
    const inflows = group
      .map((point) => finite(point.mainInflow))
      .filter((value) => value != null)
    return {
      date: latest.date,
      close: latest.close,
      pct: latest.pct,
      mainInflow: inflows.length
        ? inflows.reduce((total, value) => total + value, 0)
        : null,
      mainRatio: latest.mainRatio,
    }
  }).slice(-limit)
  return aggregated.map((point, index) => {
    if (index === 0) return point
    const previous = aggregated[index - 1].close
    return {
      ...point,
      pct: previous > 0
        ? round((point.close / previous - 1) * 100)
        : point.pct,
    }
  })
}

export function parseConceptCloseHistoryPayload(
  payload,
  fallbackCode = '',
  period = 'day',
) {
  const data = payload?.data || {}
  const daily = (Array.isArray(data.klines) ? data.klines : [])
    .flatMap((row) => {
      const fields = String(row || '').split(',')
      const date = String(fields[0] || '').trim()
      const close = finite(fields[11])
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close == null) return []
      return [{
        date,
        close,
        pct: finite(fields[12]),
        mainInflow: finite(fields[1]),
        mainRatio: finite(fields[6]),
      }]
    })
  const points = aggregateCloseHistory(daily, period)
  const latest = points.at(-1) || null
  return {
    code: String(data.code || fallbackCode || '').trim(),
    name: String(data.name || '').trim(),
    period,
    format: 'close-line',
    points,
    summary: latest
      ? {
          latest: latest.close,
          pct: latest.pct,
          high: Math.max(...points.map((point) => point.close)),
          low: Math.min(...points.map((point) => point.close)),
          amplitude: null,
          volume: null,
          amount: null,
          lastDate: latest.date,
          sampleCount: points.length,
          mainInflow: latest.mainInflow,
          mainRatio: latest.mainRatio,
        }
      : null,
  }
}

export function selectLongestConceptKlinePayload(payloads = []) {
  return (Array.isArray(payloads) ? payloads : []).reduce(
    (longest, payload) => {
      const length = Array.isArray(payload?.data?.klines)
        ? payload.data.klines.length
        : 0
      const longestLength = Array.isArray(longest?.data?.klines)
        ? longest.data.klines.length
        : 0
      return length > longestLength ? payload : longest
    },
    null,
  )
}

export function parseConceptKlinePayload(
  payload,
  fallbackCode = '',
  period = 'day',
) {
  const data = payload?.data || {}
  const points = parseConceptKlineRows(data.klines)
  const latest = points.at(-1) || null
  return {
    code: String(data.code || fallbackCode || '').trim(),
    name: String(data.name || '').trim(),
    period,
    points,
    summary: latest
      ? {
          latest: latest.close,
          pct: latest.pct,
          high: latest.high,
          low: latest.low,
          amplitude: latest.amplitude,
          volume: latest.volume,
          amount: latest.amount,
          lastDate: latest.date,
        }
      : null,
  }
}

export function formatConceptTrendTooltip(params) {
  const item = Array.isArray(params) ? params[0] : params
  const data = item?.data || {}
  const pct = finite(data.value)
  const sign = pct != null && pct > 0 ? '+' : ''
  return [
    item?.axisValue || '',
    `涨跌: ${pct == null ? '--' : `${sign}${pct.toFixed(2)}%`}`,
    `指数: ${formatNumber(data.price)}`,
    `均价: ${formatNumber(data.avg)}`,
    `成交量: ${formatNumber(data.volume)}`,
    `成交额: ${formatAmount(data.amount)}`,
  ].join('<br/>')
}

export function formatConceptKlineTooltip(params) {
  const item = (Array.isArray(params) ? params : [])
    .find((entry) => entry?.seriesType === 'candlestick')
    || (Array.isArray(params) ? params[0] : params)
  const data = item?.data || {}
  const pct = finite(data.pct)
  const sign = pct != null && pct > 0 ? '+' : ''
  return [
    item?.axisValue || '',
    `开: ${formatNumber(data.open)}`,
    `高: ${formatNumber(data.high)}`,
    `低: ${formatNumber(data.low)}`,
    `收: ${formatNumber(data.close)}`,
    `涨跌: ${pct == null ? '--' : `${sign}${pct.toFixed(2)}%`}`,
    `成交量: ${formatNumber(data.volume)}`,
    `成交额: ${formatAmount(data.amount)}`,
  ].join('<br/>')
}

export function formatConceptCloseHistoryTooltip(params) {
  const item = (Array.isArray(params) ? params : [])
    .find((entry) => entry?.seriesName === '历史收盘')
    || (Array.isArray(params) ? params[0] : params)
  const data = item?.data || {}
  const pct = finite(data.pct)
  const mainRatio = finite(data.mainRatio)
  return [
    item?.axisValue || '',
    `收盘: ${formatNumber(data.close)}`,
    `涨跌: ${pct == null ? '--' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}`,
    `主力净占: ${mainRatio == null ? '--' : `${mainRatio > 0 ? '+' : ''}${mainRatio.toFixed(2)}%`}`,
    `主力净额: ${formatAmount(data.mainInflow)}`,
  ].join('<br/>')
}
