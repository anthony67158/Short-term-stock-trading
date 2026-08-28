export const TAIL_PICK_FORMULA_VERSION = 'tail-pick-formula.v1'
export const TAIL_PICK_NEAR_MATCH_VERSION = 'tail-pick-near-match.v1'

const TAIL_PICK_RULE_COUNT = 14
const NEAR_MATCH_RELAXABLE_RULES = new Set([
  'AB4',
  'AB5',
  'HSL',
  'AB6',
  'AB7',
  'AB12B',
  'AB32',
  'AB34',
])
const NEAR_MATCH_MIN_TURNOVER = 3
const NEAR_MATCH_MIN_AMOUNT = 50_000_000

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function ratio(left, right) {
  return right > 0 ? left / right : null
}

function validBar(value = {}) {
  const bar = {
    date: String(value.date || ''),
    open: finite(value.open),
    close: finite(value.close),
    high: finite(value.high),
    low: finite(value.low),
    volume: finite(value.volume),
    amount: finite(value.amount),
  }
  return [
    bar.open,
    bar.close,
    bar.high,
    bar.low,
    bar.volume,
  ].every((item) => item != null && item >= 0)
    ? bar
    : null
}

export function mergeTailPickCurrentBar(candles = [], quote = null) {
  const bars = candles.map(validBar).filter(Boolean)
  if (!quote) return bars
  const current = validBar({
    date: quote.tradeDate,
    open: quote.open,
    close: quote.price ?? quote.close,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    amount: quote.amount,
  })
  if (!current) return bars
  const last = bars.at(-1)
  if (last?.date && current.date && last.date === current.date) {
    return [...bars.slice(0, -1), current]
  }
  return [...bars, current]
}

export function evaluateTailPickSignal({
  candles = [],
  quote = null,
  turnover = quote?.turnover,
} = {}) {
  const bars = mergeTailPickCurrentBar(candles, quote)
  if (bars.length < 31) {
    return {
      matched: false,
      sourceVersion: TAIL_PICK_FORMULA_VERSION,
      signals: [],
      failedRules: ['至少需要31根有效日K'],
      diagnostics: { bars: bars.length },
    }
  }

  const current = bars.at(-1)
  const previous = bars.at(-2)
  const twoDaysAgo = bars.at(-3)
  const threeDaysAgo = bars.at(-4)
  const volumes30 = bars.slice(-30).map((item) => item.volume)
  const previousVolumes15 = bars
    .slice(-16, -1)
    .map((item) => item.volume)
  const currentTurnover = finite(turnover)
  const checks = [
    ['AB1', previous.close < twoDaysAgo.close, '昨日收盘低于前日'],
    ['AB2', current.open < current.close, '当日收阳'],
    [
      'AB4',
      current.high - current.close
        > (current.open - current.low) * 1.5,
      '上影长度大于开盘至最低价距离的1.5倍',
    ],
    [
      'AB5',
      ratio(current.high, current.open) > 1.01
        && ratio(current.high, current.open) < 1.09,
      '最高价较开盘价高1%至9%',
    ],
    [
      'HSL',
      currentTurnover != null && currentTurnover > 5,
      '换手率大于5%',
    ],
    [
      'AB6',
      current.high < twoDaysAgo.high * 0.995,
      '最高价未越过两日前高点',
    ],
    [
      'AB8',
      ratio(twoDaysAgo.close, previous.close) > 1.034,
      '昨日较前日下跌超过约3.29%',
    ],
    [
      'AB9',
      current.volume >= Math.max(...volumes30) * 0.2,
      '当日量不低于近30日最高量的20%',
    ],
    [
      'AB10',
      ratio(current.close, previous.close) > 1.024,
      '当日涨幅超过2.4%',
    ],
    [
      'AB7',
      current.low < twoDaysAgo.low * 0.995,
      '最低价下探两日前低点',
    ],
    [
      'AB12A',
      ratio(current.high, current.close) < 1.06,
      '最高价距离收盘价不足6%',
    ],
    [
      'AB12B',
      ratio(current.high, previous.high) < 1.015,
      '最高价未明显越过昨日高点',
    ],
    [
      'AB32',
      current.volume <= Math.min(...previousVolumes15) * 4,
      '当日量不超过前15日最低量的4倍',
    ],
    [
      'AB34',
      ratio(
        Math.max(threeDaysAgo.open, threeDaysAgo.close),
        Math.min(threeDaysAgo.open, threeDaysAgo.close),
      ) < 1.04,
      '三日前K线实体幅度小于4%',
    ],
  ]
  const signals = checks
    .filter(([, passed]) => passed)
    .map(([key, , label]) => ({ key, label }))
  const failedRules = checks
    .filter(([, passed]) => !passed)
    .map(([key, , label]) => ({ key, label }))

  return {
    matched: failedRules.length === 0,
    sourceVersion: TAIL_PICK_FORMULA_VERSION,
    signals,
    failedRules,
    diagnostics: {
      bars: bars.length,
      current,
      previous,
      twoDaysAgo,
      threeDaysAgo,
      turnover: currentTurnover,
      minPreviousVolume15: Math.min(...previousVolumes15),
      maxVolume30: Math.max(...volumes30),
    },
  }
}

export function evaluateTailPickNearMatch(
  formula,
  {
    turnover = null,
    amount = null,
  } = {},
) {
  const failedRules = Array.isArray(formula?.failedRules)
    ? formula.failedRules.filter(
      (item) => item && typeof item === 'object' && item.key,
    )
    : []
  const failedKeys = failedRules.map((item) => item.key)
  const hardFailures = failedRules.filter(
    (item) => !NEAR_MATCH_RELAXABLE_RULES.has(item.key),
  )
  const currentTurnover = finite(turnover)
  const currentAmount = finite(amount)
  const blockers = []

  if (formula?.matched) blockers.push('已进入严格公式命中池')
  if (!failedRules.length && !formula?.matched) {
    blockers.push('公式数据不足，无法计算接近程度')
  }
  if (failedRules.length > 2) blockers.push('距离严格公式超过2项')
  if (hardFailures.length) {
    blockers.push(`核心条件未通过：${
      hardFailures.map((item) => item.label).join('、')
    }`)
  }
  if (
    failedKeys.includes('HSL')
    && !(currentTurnover >= NEAR_MATCH_MIN_TURNOVER)
  ) {
    blockers.push('换手率低于接近公式的3%底线')
  }
  if (!(currentAmount >= NEAR_MATCH_MIN_AMOUNT)) {
    blockers.push('成交额低于5000万元')
  }

  return {
    matched: blockers.length === 0,
    sourceVersion: TAIL_PICK_NEAR_MATCH_VERSION,
    matchRate: +(
      (TAIL_PICK_RULE_COUNT - failedRules.length)
      / TAIL_PICK_RULE_COUNT
      * 100
    ).toFixed(1),
    failedRules,
    blockers,
  }
}
