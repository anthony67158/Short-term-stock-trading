// 市场状态分段 + 未调参年度测试集划分（任务7：跨市场年度验证的口径）。
//
// 用途：用基准指数(沪深300)日线序列，把每个交易日归类为 BULL/CHOP/RETREAT，
// 供年度回放按牛市/震荡/退潮分段核对；并把「最后一个完整自然年」标为未调参
// 测试集(holdout)，其余年份为可调参区。这样任务2 的验收门槛能在真正未参与
// 调参的年度上给出可信结论。
//
// 纯函数、无 IO、确定性。分段是描述性口径，不改任何交易决策。

export const MARKET_REGIME_SEGMENTATION_VERSION =
  'market-regime-segmentation.v1'

export const MARKET_REGIMES = Object.freeze(['BULL', 'CHOP', 'RETREAT'])

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function compactDate(value) {
  const m = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/)
  return m ? `${m[1]}${m[2]}${m[3]}` : null
}

function sma(values, end, window) {
  if (end + 1 < window) return null
  let sum = 0
  for (let i = end - window + 1; i <= end; i += 1) sum += values[i]
  return sum / window
}

// 归一化指数序列为 [{date, close}]，按日期升序去重。
function normalizeIndex(rows) {
  const seen = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = compactDate(row?.date ?? row?.trade_date)
    const close = finite(row?.close)
    if (!date || close == null || !(close > 0)) continue
    seen.set(date, close)
  }
  return [...seen.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, close]) => ({ date, close }))
}

// 逐日分段：
//   BULL    —— 收盘在长均线上方且长均线上行；
//   RETREAT —— 收盘在长均线下方且长均线下行；
//   CHOP    —— 其余（含均线走平/穿越）。
export function segmentMarketRegime(
  indexRows,
  { fastWindow = 20, slowWindow = 60 } = {},
) {
  const series = normalizeIndex(indexRows)
  const closes = series.map((r) => r.close)
  const days = series.map((entry, i) => {
    const slow = sma(closes, i, slowWindow)
    const slowPrev = sma(closes, i - 1, slowWindow)
    const fast = sma(closes, i, fastWindow)
    let regime = 'CHOP'
    if (slow != null && slowPrev != null && fast != null) {
      const slowUp = slow > slowPrev
      const above = entry.close >= slow
      if (above && slowUp && fast >= slow) regime = 'BULL'
      else if (!above && !slowUp && fast < slow) regime = 'RETREAT'
      else regime = 'CHOP'
    }
    return { date: entry.date, close: entry.close, regime }
  })
  const counts = { BULL: 0, CHOP: 0, RETREAT: 0 }
  for (const d of days) counts[d.regime] += 1
  return {
    schemaVersion: MARKET_REGIME_SEGMENTATION_VERSION,
    days,
    counts,
    coverage: days.length,
  }
}

// 按自然年切分，最后一个「完整」年为未调参测试集。
// completeYearMinDays: 认定某年完整所需的最少交易日数（约 200，防半年样本冒充整年）。
export function annualHoldoutSplit(
  indexRows,
  { completeYearMinDays = 200 } = {},
) {
  const series = normalizeIndex(indexRows)
  const byYear = new Map()
  for (const entry of series) {
    const year = entry.date.slice(0, 4)
    byYear.set(year, (byYear.get(year) || 0) + 1)
  }
  const years = [...byYear.keys()].sort()
  const completeYears = years.filter(
    (y) => byYear.get(y) >= completeYearMinDays,
  )
  const holdoutYear = completeYears.length
    ? completeYears[completeYears.length - 1]
    : null
  return {
    schemaVersion: MARKET_REGIME_SEGMENTATION_VERSION,
    years,
    yearDayCounts: Object.fromEntries(byYear),
    completeYears,
    // 未调参测试集：最后一个完整年；不足时为 null，调用方据此判定「不可给年度结论」。
    holdoutYear,
    tuningYears: completeYears.filter((y) => y !== holdoutYear),
    provable: holdoutYear != null && completeYears.length >= 2,
    note: holdoutYear != null && completeYears.length >= 2
      ? undefined
      : '完整自然年不足2个，无法在未调参年度上给出可信年度结论。',
  }
}
