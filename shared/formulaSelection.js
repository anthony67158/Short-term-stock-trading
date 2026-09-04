export const FORMULA_SELECTION_SCHEMA_VERSION = 'formula-selection.v1'

export const FORMULA_IDS = Object.freeze({
  TAIL_REVERSAL: 'TAIL_REVERSAL',
  INTRADAY_VWAP_PULLBACK: 'INTRADAY_VWAP_PULLBACK',
  INTRADAY_ACCUMULATION: 'INTRADAY_ACCUMULATION',
  CLOSE_TREND_PULLBACK: 'CLOSE_TREND_PULLBACK',
  CLOSE_SQUEEZE: 'CLOSE_SQUEEZE',
})

export const FORMULA_REGISTRY = Object.freeze([
  {
    formulaId: FORMULA_IDS.INTRADAY_VWAP_PULLBACK,
    name: '盘中回踩承接',
    mode: 'INTRADAY',
  },
  {
    formulaId: FORMULA_IDS.INTRADAY_ACCUMULATION,
    name: '盘中资金先行',
    mode: 'INTRADAY',
  },
  {
    formulaId: FORMULA_IDS.CLOSE_TREND_PULLBACK,
    name: '收盘趋势回踩',
    mode: 'CLOSE',
  },
  {
    formulaId: FORMULA_IDS.CLOSE_SQUEEZE,
    name: '收盘蓄势突破',
    mode: 'CLOSE',
  },
])

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function normalizeCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((bar) => ({
      date: String(bar?.date || ''),
      open: finite(bar?.open),
      high: finite(bar?.high),
      low: finite(bar?.low),
      close: finite(bar?.close),
      volume: finite(bar?.volume),
      amount: finite(bar?.amount),
    }))
    .filter((bar) =>
      bar.date
      && bar.open != null
      && bar.high != null
      && bar.low != null
      && bar.close != null,
    )
    .sort((left, right) => left.date.localeCompare(right.date))
}

function average(values = []) {
  const valid = values.filter((value) => finite(value) != null)
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length
}

function sma(rows, period, offset = 0, key = 'close') {
  const end = rows.length - offset
  const start = end - period
  if (start < 0 || end <= start) return null
  return average(rows.slice(start, end).map((row) => row[key]))
}

function atr(rows, period = 14) {
  if (rows.length < period + 1) return null
  const values = []
  for (let index = rows.length - period; index < rows.length; index += 1) {
    const current = rows[index]
    const previousClose = rows[index - 1]?.close
    values.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose),
    ))
  }
  return average(values)
}

function bollinger(rows, period = 20) {
  const values = rows.slice(-period).map((row) => row.close)
  if (values.length < period) return null
  const mid = average(values)
  const variance = average(values.map((value) => (value - mid) ** 2))
  const deviation = Math.sqrt(variance)
  const upper = mid + deviation * 2
  const lower = mid - deviation * 2
  return {
    mid,
    upper,
    lower,
    widthPct: mid > 0 ? (upper - lower) / mid * 100 : null,
  }
}

function latestVwap(trends = []) {
  for (let index = trends.length - 1; index >= 0; index -= 1) {
    const value = finite(trends[index]?.avg ?? trends[index]?.vwap)
    if (value != null) return value
  }
  return null
}

function numberText(value, digits = 2) {
  const number = finite(value)
  return number == null ? '缺失' : number.toFixed(digits)
}

function amountText(value) {
  const number = finite(value)
  return number == null ? '缺失' : `${(number / 100_000_000).toFixed(2)}亿元`
}

function fundBlocker(fund = {}) {
  const mainNow = finite(fund.mainNetYi)
  const retailNow = finite(fund.retailNetYi)
  const main5d = finite(fund.main5dYi)
  if (mainNow == null || retailNow == null || main5d == null) {
    return '资金证据不完整：缺少当日主力、小单或近5日主力净额'
  }
  if (mainNow < 0 && retailNow > 0) {
    return `主力净流出${Math.abs(mainNow).toFixed(2)}亿元、`
      + `小单净流入${retailNow.toFixed(2)}亿元，存在散户承接`
  }
  return `主力承接不足：当日${mainNow.toFixed(2)}亿元、`
    + `近5日${main5d.toFixed(2)}亿元`
}

function atrDistanceBlocker(label, current, anchor, atrValue, limit = 1) {
  if (!(finite(anchor) > 0) || !(finite(atrValue) > 0)) {
    return `${label}无法校验：支撑位或ATR数据缺失`
  }
  const distance = finite(current) - finite(anchor)
  return `${label}${numberText(distance)}元，超过`
    + `${limit}ATR上限${numberText(finite(atrValue) * limit)}元`
}

function fundSupported(fund = {}) {
  const mainNow = finite(fund.mainNetYi)
  const retailNow = finite(fund.retailNetYi)
  const main5d = finite(fund.main5dYi)
  if (mainNow == null || retailNow == null || main5d == null) return false
  return (
    !(mainNow < 0 && retailNow > 0)
    && (mainNow > 0 || main5d > 0)
  )
}

function commonContext(input = {}) {
  const candles = normalizeCandles(input.candles)
  const quote = input.quote || {}
  const current = finite(quote.price) ?? candles.at(-1)?.close ?? null
  const currentOpen = finite(quote.open) ?? candles.at(-1)?.open ?? null
  const currentAmount =
    finite(quote.amount) ?? candles.at(-1)?.amount ?? null
  const currentTurnover = finite(quote.turnover)
  const currentPct = finite(quote.pct)
  const currentVolume = finite(quote.volume) ?? candles.at(-1)?.volume ?? null
  const ma10 = sma(candles, 10)
  const ma20 = sma(candles, 20)
  const ma20Past = sma(candles, 20, 3)
  const atr14 = atr(candles)
  const boll = bollinger(candles)
  const base20 = candles.at(-21)?.close
  const gain20 = current != null && base20 > 0
    ? (current / base20 - 1) * 100
    : null
  const support = candles.length >= 10
    ? Math.min(...candles.slice(-10).map((bar) => bar.low))
    : null
  const resistance = candles.length >= 20
    ? Math.max(...candles.slice(-20).map((bar) => bar.high))
    : null
  return {
    candles,
    quote,
    trends: Array.isArray(input.trends) ? input.trends : [],
    fund: input.fund || {},
    sectorOpportunity: input.sectorOpportunity || {},
    current,
    currentOpen,
    currentAmount,
    currentTurnover,
    currentPct,
    currentVolume,
    ma10,
    ma20,
    ma20Past,
    atr14,
    boll,
    gain20,
    support,
    resistance,
    volumeAvg5: sma(candles, 5, 0, 'volume'),
    vwap: latestVwap(Array.isArray(input.trends) ? input.trends : []),
  }
}

function result(formulaId, name, matched, score, input = {}) {
  return {
    formulaId,
    name,
    matched,
    score: matched ? score : 0,
    validationState: 'OBSERVE_ONLY',
    action: matched ? 'WATCH_BUY' : 'AVOID',
    priceType: input.priceType || null,
    anchors: {
      primary: round(input.primary),
      support: round(input.support),
      resistance: round(input.resistance),
      atr: round(input.atr),
      vwap: round(input.vwap),
    },
    evidence: (input.evidence || []).filter(Boolean).slice(0, 4),
    blockers: (input.blockers || []).filter(Boolean),
  }
}

function evaluateIntradayPullback(context) {
  const blockers = []
  const lastTrends = context.trends.slice(-3)
  const heldVwap = (
    context.vwap != null
    && lastTrends.length === 3
    && lastTrends.every(
      (item) => finite(item.price) >= finite(item.avg ?? item.vwap),
    )
  )
  const noDump = lastTrends.length === 3
    && finite(lastTrends.at(-1)?.price)
      >= finite(lastTrends[0]?.price) * 0.985
  const anchorValues = [
    context.vwap,
    context.ma10,
    context.support,
  ].filter((value) => value != null && value <= context.current)
  const primary = anchorValues.length ? Math.max(...anchorValues) : null

  if (context.candles.length < 30) {
    blockers.push(`日线仅${context.candles.length}日，要求至少30日`)
  }
  if (!(context.current > context.ma20)) {
    blockers.push(
      `当前价${numberText(context.current)}元，未站上`
      + `MA20 ${numberText(context.ma20)}元`,
    )
  }
  if (!(context.ma20 >= context.ma20Past)) {
    blockers.push(
      `MA20由${numberText(context.ma20Past)}元降至`
      + `${numberText(context.ma20)}元，趋势仍向下`,
    )
  }
  if (!(context.gain20 <= 25)) {
    blockers.push(
      `近20日已上涨${numberText(context.gain20, 1)}%，`
      + '超过25%上限',
    )
  }
  if (!(context.currentPct <= 5)) {
    blockers.push(
      `当日已上涨${numberText(context.currentPct, 1)}%，`
      + '超过5%追高线',
    )
  }
  if (!(context.currentAmount >= 50_000_000)) {
    blockers.push(
      `当前成交额${amountText(context.currentAmount)}，`
      + '要求至少0.50亿元',
    )
  }
  if (!(context.currentTurnover >= 2)) {
    blockers.push(
      `当前换手率${numberText(context.currentTurnover, 1)}%，`
      + '要求至少2%',
    )
  }
  if (!heldVwap || !noDump) {
    blockers.push(
      `最近3分钟未持续站稳VWAP ${numberText(context.vwap)}元`
      + '，或区间回落超过1.5%',
    )
  }
  if (!context.sectorOpportunity.matched) {
    blockers.push('所属行业或概念未进入今日板块前瞻确认范围')
  }
  if (!fundSupported(context.fund)) blockers.push(fundBlocker(context.fund))
  if (
    primary == null
    || !(context.atr14 > 0)
    || context.current - primary > context.atr14
  ) blockers.push(atrDistanceBlocker(
    '当前价距离支撑',
    context.current,
    primary,
    context.atr14,
  ))

  return result(
    FORMULA_IDS.INTRADAY_VWAP_PULLBACK,
    '盘中回踩承接',
    blockers.length === 0,
    88,
    {
      primary,
      support: primary,
      resistance: context.resistance,
      atr: context.atr14,
      vwap: context.vwap,
      priceType: 'PULLBACK_WATCH',
      evidence: [
        'MA20向上且价格保持其上',
        '最近3根分钟K站稳VWAP',
        '板块与主力资金确认',
      ],
      blockers,
    },
  )
}

function evaluateIntradayAccumulation(context) {
  const blockers = []
  const recent = context.trends.slice(-5)
  const heldVwap = (
    context.vwap != null
    && recent.length >= 3
    && recent.filter(
      (item) => finite(item.price) >= finite(item.avg ?? item.vwap),
    ).length >= recent.length - 1
  )
  const anchorValues = [
    context.vwap,
    context.ma10,
    context.support,
  ].filter((value) => value != null && value <= context.current)
  const primary = anchorValues.length ? Math.max(...anchorValues) : null

  if (!(context.currentPct >= 0.5 && context.currentPct <= 4)) {
    blockers.push(
      `当前涨幅${numberText(context.currentPct, 1)}%，`
      + '资金先行要求0.5%至4%',
    )
  }
  if (!(context.currentTurnover >= 2 && context.currentTurnover <= 8)) {
    blockers.push(
      `当前换手率${numberText(context.currentTurnover, 1)}%，`
      + '要求2%至8%',
    )
  }
  if (!(context.currentAmount >= 100_000_000)) {
    blockers.push(
      `当前成交额${amountText(context.currentAmount)}，`
      + '要求至少1.00亿元',
    )
  }
  if (!(finite(context.quote.volumeRatio) >= 1.2)) {
    blockers.push(
      `当前量比${numberText(context.quote.volumeRatio)}，`
      + '要求至少1.20',
    )
  }
  if (!(context.gain20 <= 20)) {
    blockers.push(
      `近20日已上涨${numberText(context.gain20, 1)}%，`
      + '超过20%上限',
    )
  }
  if (!heldVwap) {
    blockers.push(
      `最近5分钟未稳定在VWAP ${numberText(context.vwap)}元上方`,
    )
  }
  if (!context.sectorOpportunity.matched) {
    blockers.push('所属行业或概念未进入今日板块前瞻确认范围')
  }
  if (!fundSupported(context.fund)) blockers.push(fundBlocker(context.fund))
  if (
    primary == null
    || !(context.atr14 > 0)
    || context.current - primary > context.atr14
  ) blockers.push(atrDistanceBlocker(
    '当前价距离承接位',
    context.current,
    primary,
    context.atr14,
  ))

  return result(
    FORMULA_IDS.INTRADAY_ACCUMULATION,
    '盘中资金先行',
    blockers.length === 0,
    84,
    {
      primary,
      support: primary,
      resistance: context.resistance,
      atr: context.atr14,
      vwap: context.vwap,
      priceType: 'PULLBACK_WATCH',
      evidence: [
        '涨幅温和且量比放大',
        '价格保持VWAP上方',
        '主力资金和板块方向确认',
      ],
      blockers,
    },
  )
}

function evaluateCloseTrendPullback(context) {
  const blockers = []
  const anchorValues = [context.ma10, context.support]
    .filter((value) => value != null && value <= context.current)
  const primary = anchorValues.length ? Math.max(...anchorValues) : null
  const latest = context.candles.at(-1)

  if (!(context.current > context.ma20)) {
    blockers.push(
      `收盘价${numberText(context.current)}元，未站上`
      + `MA20 ${numberText(context.ma20)}元`,
    )
  }
  if (!(context.ma20 >= context.ma20Past)) {
    blockers.push(
      `MA20由${numberText(context.ma20Past)}元降至`
      + `${numberText(context.ma20)}元，趋势仍向下`,
    )
  }
  if (!(context.gain20 >= 5 && context.gain20 <= 25)) {
    blockers.push(
      `近20日涨幅${numberText(context.gain20, 1)}%，`
      + '要求5%至25%',
    )
  }
  if (
    primary == null
    || !(context.atr14 > 0)
    || context.current - primary > context.atr14 * 1.25
  ) blockers.push(atrDistanceBlocker(
    '收盘价距离支撑',
    context.current,
    primary,
    context.atr14,
    1.25,
  ))
  if (
    context.currentVolume != null
    && context.volumeAvg5 != null
    && context.currentVolume > context.volumeAvg5 * 0.9
  ) blockers.push(
    `当日成交量为5日均量的${numberText(
      context.currentVolume / context.volumeAvg5 * 100,
      0,
    )}%，要求不高于90%`,
  )
  if (!(context.current >= context.currentOpen || context.current >= context.ma10)) {
    blockers.push(
      `收盘价${numberText(context.current)}元仍低于开盘价`
      + `${numberText(context.currentOpen)}元和MA10 `
      + `${numberText(context.ma10)}元`,
    )
  }
  if (!context.sectorOpportunity.matched) {
    blockers.push('所属行业或概念未进入今日板块前瞻确认范围')
  }
  if (!fundSupported(context.fund)) blockers.push(fundBlocker(context.fund))

  return result(
    FORMULA_IDS.CLOSE_TREND_PULLBACK,
    '收盘趋势回踩',
    blockers.length === 0,
    86,
    {
      primary,
      support: primary,
      resistance: context.resistance,
      atr: context.atr14,
      priceType: 'PULLBACK_WATCH',
      evidence: [
        'MA20向上且收盘保持其上',
        latest?.volume <= context.volumeAvg5 * 0.9 ? '回踩缩量' : null,
        '板块和资金承接确认',
      ],
      blockers,
    },
  )
}

function evaluateCloseSqueeze(context) {
  const blockers = []
  const primary = context.resistance != null
    ? round(context.resistance + 0.01)
    : null

  if (!(context.boll?.widthPct <= 6)) {
    blockers.push(
      `布林带宽度${numberText(context.boll?.widthPct, 1)}%，`
      + '要求不高于6%',
    )
  }
  if (!(context.current >= context.boll?.mid)) {
    blockers.push(
      `收盘价${numberText(context.current)}元，未站上布林中轨`
      + `${numberText(context.boll?.mid)}元`,
    )
  }
  if (!(context.ma20 >= context.ma20Past)) {
    blockers.push(
      `MA20由${numberText(context.ma20Past)}元降至`
      + `${numberText(context.ma20)}元，趋势仍向下`,
    )
  }
  if (!(context.gain20 <= 20)) {
    blockers.push(
      `近20日已上涨${numberText(context.gain20, 1)}%，`
      + '超过20%上限',
    )
  }
  if (!(context.currentPct <= 4)) {
    blockers.push(
      `当日已上涨${numberText(context.currentPct, 1)}%，`
      + '超过4%追高线',
    )
  }
  if (!(context.currentAmount >= 50_000_000)) {
    blockers.push(
      `当前成交额${amountText(context.currentAmount)}，`
      + '要求至少0.50亿元',
    )
  }
  if (
    context.currentVolume != null
    && context.volumeAvg5 != null
    && context.currentVolume >= context.volumeAvg5
  ) blockers.push(
    `当日成交量为5日均量的${numberText(
      context.currentVolume / context.volumeAvg5 * 100,
      0,
    )}%，要求低于100%`,
  )
  if (!context.sectorOpportunity.matched) {
    blockers.push('所属行业或概念未进入今日板块前瞻确认范围')
  }
  if (!fundSupported(context.fund)) blockers.push(fundBlocker(context.fund))

  return result(
    FORMULA_IDS.CLOSE_SQUEEZE,
    '收盘蓄势突破',
    blockers.length === 0,
    82,
    {
      primary,
      support: context.boll?.mid,
      resistance: context.resistance,
      atr: context.atr14,
      priceType: 'BREAKOUT_WATCH',
      evidence: [
        '布林带宽度低于6%',
        '收盘位于布林中轨上方',
        '量能收敛且板块资金确认',
      ],
      blockers,
    },
  )
}

export function evaluateFormulaSelection(input = {}) {
  const mode = String(input.mode || '').toLowerCase()
  const context = commonContext(input)
  const evaluations = mode === 'intraday'
    ? [
        evaluateIntradayPullback(context),
        evaluateIntradayAccumulation(context),
      ]
    : mode === 'close'
      ? [
          evaluateCloseTrendPullback(context),
          evaluateCloseSqueeze(context),
        ]
      : []
  return {
    schemaVersion: FORMULA_SELECTION_SCHEMA_VERSION,
    mode: mode.toUpperCase(),
    matches: evaluations
      .filter((item) => item.matched)
      .sort((left, right) => right.score - left.score),
    evaluations,
  }
}
