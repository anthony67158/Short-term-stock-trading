function stableHash(value) {
  let hash = 2166136261
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function uniqueDates(dailyRows) {
  return [...new Set(
    (Array.isArray(dailyRows) ? dailyRows : [])
      .map((row) => String(row?.date || ''))
      .filter((date) => /^\d{8}$/.test(date)),
  )].sort()
}

export function selectReplayDates(dailyRows, {
  signalDays = 90,
  settlementDays = 7,
  historyDays = 60,
} = {}) {
  const dates = uniqueDates(dailyRows)
  const required = historyDays + signalDays + settlementDays
  if (dates.length < required) {
    throw new Error(
      `StockDB交易日不足：${dates.length}/${required}`,
    )
  }
  const signalEnd = dates.length - settlementDays
  const signalStart = Math.max(
    historyDays,
    signalEnd - signalDays,
  )
  return {
    allDates: dates,
    historyDates: dates.slice(signalStart - historyDays, signalStart),
    signalDates: dates.slice(signalStart, signalEnd),
    processingDates: dates.slice(signalStart, dates.length),
  }
}

function latestBefore(rows, tradeDate) {
  let result = null
  for (const row of rows) {
    if (row.date >= tradeDate) break
    result = row
  }
  return result
}

function eligiblePreviousRow(row) {
  return (
    row
    && /^\d{6}$/.test(String(row.code || ''))
    && !row.isSt
    && !/ST|退/i.test(String(row.name || ''))
    && Number(row.close) > 0
    && Number(row.amount) >= 30_000_000
    && Number(row.turnover) >= 0.3
  )
}

export function selectCausalUniverse(
  dailyByCode,
  tradeDate,
  {
    limit = 1000,
    liquidShare = 0.8,
  } = {},
) {
  const candidates = []
  for (const [code, rows] of dailyByCode.entries()) {
    const previous = latestBefore(rows, tradeDate)
    if (!eligiblePreviousRow(previous)) continue
    candidates.push({ code, row: previous })
  }
  const normalizedLimit = Math.max(100, Math.trunc(Number(limit) || 1000))
  const liquidLimit = Math.max(
    1,
    Math.min(
      normalizedLimit,
      Math.trunc(normalizedLimit * liquidShare),
    ),
  )
  const liquid = candidates.slice().sort((left, right) =>
    Number(right.row.amount) - Number(left.row.amount)
    || left.code.localeCompare(right.code)
  ).slice(0, liquidLimit)
  const selected = new Set(liquid.map((item) => item.code))
  const exploration = candidates
    .filter((item) => !selected.has(item.code))
    .sort((left, right) =>
      stableHash(`${tradeDate}:${left.code}`)
        - stableHash(`${tradeDate}:${right.code}`)
      || left.code.localeCompare(right.code)
    )
  for (const item of exploration) {
    if (selected.size >= normalizedLimit) break
    selected.add(item.code)
  }
  return [...selected].sort()
}

export function buildMinuteExportManifest({
  processingDates,
  signalDates,
  universesByDate,
  holdingSessions = 6,
} = {}) {
  const signalSet = new Set(signalDates)
  const active = []
  return {
    schemaVersion: 'stockdb-minute-export-manifest.v1',
    dates: processingDates.map((date) => {
      if (signalSet.has(date)) {
        active.push({
          date,
          codes: universesByDate.get(date) || [],
        })
      }
      const index = processingDates.indexOf(date)
      const oldest = Math.max(0, index - holdingSessions)
      const allowedDates = new Set(
        processingDates.slice(oldest, index + 1),
      )
      while (active.length && !allowedDates.has(active[0].date)) {
        active.shift()
      }
      return {
        date,
        codes: [...new Set(
          active.flatMap((item) => item.codes),
        )].sort(),
      }
    }).filter((row) => row.codes.length),
  }
}
