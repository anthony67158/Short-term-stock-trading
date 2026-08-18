function finiteOrNull(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null
  const base = 10 ** digits
  return Math.round((value + Number.EPSILON) * base) / base
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatSigned(value, suffix = '', digits = 2) {
  if (value === null || value === undefined || value === '' || value === '-') return '--'
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}${suffix}`
}

function formatYi(value) {
  if (value === null || value === undefined || value === '' || value === '-') return '--'
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number > 0 ? '+' : ''}${(number / 1e8).toFixed(2)}亿`
}

export function selectLongestKlines(payloads = []) {
  return payloads.reduce((longest, payload) => {
    const rows = payload?.data?.klines
    return Array.isArray(rows) && rows.length > longest.length ? rows : longest
  }, [])
}

export function parseSectorFlowRows(rows = [], days = 10) {
  const limit = Math.max(1, Math.min(30, Number(days) || 10))
  return rows
    .slice(-limit)
    .map((row) => {
      const fields = typeof row === 'string' ? row.split(',') : []
      const date = fields[0]
      const mainInflow = finiteOrNull(fields[1])
      const mainRatio = finiteOrNull(fields[6])
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || mainRatio === null) return null
      return {
        date,
        mainInflow,
        mainRatio,
        close: finiteOrNull(fields[11]),
        pct: finiteOrNull(fields[12]),
      }
    })
    .filter(Boolean)
}

export function buildSectorFlowView(series = []) {
  const valid = Array.isArray(series)
    ? series.filter((item) => item && typeof item.date === 'string' && Number.isFinite(Number(item.mainRatio)))
    : []
  const latest = valid.at(-1) || null
  const lastFive = valid.slice(-5)
  const inflowDays = valid.filter((item) => Number(item.mainRatio) > 0).length
  const fiveDayAmounts = lastFive
    .map((item) => finiteOrNull(item.mainInflow))
    .filter((value) => value !== null)
  const fiveDayNet = fiveDayAmounts.length > 0
    ? fiveDayAmounts.reduce((sum, value) => sum + value, 0)
    : null

  let streak = 0
  if (latest) {
    const direction = Math.sign(Number(latest.mainRatio))
    if (direction !== 0) {
      for (let index = valid.length - 1; index >= 0; index -= 1) {
        if (Math.sign(Number(valid[index].mainRatio)) !== direction) break
        streak += direction
      }
    }
  }

  const latestRatio = finiteOrNull(latest?.mainRatio)
  const latestPct = finiteOrNull(latest?.pct)
  let relation = '方向分化'
  if (latestRatio !== null && latestPct !== null) {
    if (latestRatio > 0 && latestPct > 0) relation = '价资共振'
    else if (latestRatio > 0 && latestPct <= 0) relation = '逆势承接'
    else if (latestRatio < 0 && latestPct >= 0) relation = '上涨流出'
    else if (latestRatio < 0 && latestPct < 0) relation = '同步走弱'
  }

  return {
    sampleDays: valid.length,
    dates: valid.map((item) => item.date.slice(5)),
    ratios: valid.map((item) => round(Number(item.mainRatio))),
    pcts: valid.map((item) => item.pct == null ? null : round(Number(item.pct))),
    inflowDays,
    streak,
    fiveDayNetYi: fiveDayNet === null ? null : round(fiveDayNet / 1e8),
    relation,
  }
}

export function formatSectorFlowTooltip(params = []) {
  const point = params.find((item) => item?.data && typeof item.data === 'object')
  if (!point) return ''
  const data = point.data
  return [
    escapeHtml(point.axisValue),
    `主力净占比: ${formatSigned(data.value, '%')}`,
    `主力净额: ${formatYi(data.mainInflow)}`,
    `板块涨跌: ${formatSigned(data.pct, '%')}`,
  ].join('<br/>')
}
