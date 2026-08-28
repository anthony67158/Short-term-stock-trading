import {
  beijingDate,
  beijingDayKey,
  beijingMinutes,
  isTradingDayAt,
  nextTradingDate,
} from './tradingCalendar.js'
import { deriveMarketRegime } from './marketRegime.js'

export const TAIL_PICK_POLICY_VERSION = 'tail-pick-policy.v1'
export const TAIL_PICK_WINDOW = Object.freeze({
  opensAtMinute: 14 * 60 + 50,
  closesAtMinute: 14 * 60 + 55,
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function movingAverage(candles, days, field = 'close') {
  const values = candles
    .slice(-days)
    .map((item) => finite(item?.[field]))
    .filter((value) => value != null)
  return values.length === days ? average(values) : null
}

function timeLabel(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:`
    + String(minutes % 60).padStart(2, '0')
}

export function tailPickSession(
  timestamp = Date.now(),
  { hasResult = false } = {},
) {
  const date = beijingDate(timestamp)
  const minutes = beijingMinutes(timestamp)
  const tradeDate = beijingDayKey(timestamp)
  if (!isTradingDayAt(timestamp)) {
    return {
      status: 'REST',
      canRun: true,
      formalRunDue: false,
      tradeDate,
      label: '手动复盘',
      reason: '今天休市，手动运行只按最近交易日收盘数据试算',
    }
  }
  if (minutes < TAIL_PICK_WINDOW.opensAtMinute) {
    return {
      status: 'BEFORE_WINDOW',
      canRun: true,
      formalRunDue: false,
      tradeDate,
      label: '手动试算',
      reason: `14:50自动正式扫描；当前距正式扫描还有${
        TAIL_PICK_WINDOW.opensAtMinute - minutes
      }分钟`,
    }
  }
  if (minutes < TAIL_PICK_WINDOW.closesAtMinute) {
    return {
      status: 'OPEN',
      canRun: true,
      formalRunDue: !hasResult,
      tradeDate,
      label: hasResult ? '重新试算' : '立即试算',
      reason: hasResult
        ? '14:50正式版已生成；手动试算不会覆盖正式版'
        : '14:50自动任务正在生成或可由手动试算兜底',
    }
  }
  return {
    status: minutes < 15 * 60 ? 'LOCKED' : 'CLOSED',
    canRun: true,
    formalRunDue: false,
    tradeDate,
    label: '手动复盘',
    reason: `正式执行窗口已在${timeLabel(
      TAIL_PICK_WINDOW.closesAtMinute,
    )}结束；手动运行仅用于复盘，不产生买入指令`,
    hour: date.getHours(),
  }
}

function normalizedIndexSeries(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      code: String(item?.code || ''),
      name: String(item?.name || ''),
      candles: (Array.isArray(item?.candles) ? item.candles : [])
        .filter((bar) => finite(bar?.close) != null),
    }))
    .filter((item) => item.candles.length >= 60)
}

function indexGate(item) {
  const candles = item.candles
  const current = candles.at(-1)
  const close = finite(current?.close)
  const ma5 = movingAverage(candles, 5)
  const ma10 = movingAverage(candles, 10)
  const ma20 = movingAverage(candles, 20)
  const ma60 = movingAverage(candles, 60)
  const recent = candles.slice(-3)
  const priorVolumes = candles.slice(-8, -3)
  const falling = recent.every((bar, index) =>
    index === 0
      ? finite(bar?.close) < finite(candles.at(-4)?.close)
      : finite(bar?.close) < finite(recent[index - 1]?.close)
  )
  const recentVolume = average(
    recent.map((bar) => finite(bar?.volume)).filter((value) => value != null),
  )
  const priorVolume = average(
    priorVolumes
      .map((bar) => finite(bar?.volume))
      .filter((value) => value != null),
  )
  return {
    code: item.code,
    name: item.name,
    close,
    ma5,
    ma10,
    ma20,
    ma60,
    bullishStack: ma5 >= ma10 && ma10 >= ma20,
    aboveMa20: close >= ma20,
    belowMa60: close < ma60,
    volumeSelloff:
      falling
      && close < ma60
      && recentVolume != null
      && priorVolume != null
      && recentVolume > priorVolume * 1.1,
  }
}

export function evaluateTailPickMarketGate({
  market = {},
  indexSeries = [],
  sectorSnapshot = null,
} = {}) {
  const reasons = []
  const blockers = []
  const regime = deriveMarketRegime(market)
  if (!regime.allowRiskIncrease) {
    blockers.push(
      regime.dataQuality === 'MISSING'
        ? '大盘关键数据不完整'
        : '当前盘面不允许新增风险',
    )
  }

  const indices = normalizedIndexSeries(indexSeries).map(indexGate)
  if (indices.length < 2) {
    blockers.push('核心指数60日数据不完整')
  } else {
    const aboveMa20 = indices.filter((item) => item.aboveMa20).length
    const bullish = indices.filter((item) => item.bullishStack).length
    if (aboveMa20 < 2 || bullish < 1) {
      blockers.push('核心指数尚未形成5/10/20日均线总体偏强结构')
    } else {
      reasons.push('核心指数站稳20日线且短中期均线结构未破坏')
    }
    if (indices.some((item) => item.volumeSelloff)) {
      blockers.push('核心指数连续放量下跌并跌破60日线')
    }
  }

  const sectors = Array.isArray(sectorSnapshot?.sectors)
    ? sectorSnapshot.sectors
    : []
  const mainlines = sectors.filter((item) =>
    ['LAYOUT', 'WAIT_PULLBACK'].includes(item?.actionability)
    && Number(item?.forecast?.next?.score || 0) >= 55
  )
  if (!mainlines.length) {
    blockers.push('今天没有通过板块前瞻确认的主线方向')
  } else {
    reasons.push(`板块前瞻确认${mainlines.length}个可跟踪方向`)
  }

  return {
    allowed: blockers.length === 0,
    label: blockers.length ? '今日不开仓' : '允许公式观察',
    reasons,
    blockers,
    dataAsOf: Number(market?.updatedAt) || null,
    regime: {
      label: regime.label,
      score: regime.score,
      targetPositionPct: regime.targetPositionPct,
    },
    indices,
    sourceVersion: TAIL_PICK_POLICY_VERSION,
  }
}

function minuteOfDay(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

export function evaluateTailPickIntraday(trends = []) {
  const rows = (Array.isArray(trends) ? trends : [])
    .filter((item) =>
      finite(item?.price) > 0
      && finite(item?.avg) > 0
      && minuteOfDay(item?.time) != null
    )
  if (rows.length < 10) {
    return {
      passed: false,
      blockers: ['分时数据不足10分钟'],
      evidence: [],
    }
  }
  const recent = rows.slice(-10)
  const latest5 = recent.slice(-5)
  const last = recent.at(-1)
  const prices = recent.map((item) => finite(item.price))
  const last3 = recent.slice(-3)
  const previous5 = recent.slice(-8, -3)
  const averageVolume = (items) => average(
    items.map((item) => finite(item.volume) || 0),
  ) || 0
  const threeMinuteGain = (
    finite(last3[0]?.price) > 0
      ? (finite(last?.price) / finite(last3[0]?.price) - 1) * 100
      : 0
  )
  const drawdownFromHigh = (
    Math.max(...prices) > 0
      ? (finite(last.price) / Math.max(...prices) - 1) * 100
      : 0
  )
  const latest5AboveVwap = latest5.every(
    (item) => finite(item.price) >= finite(item.avg),
  )
  const volumeDive = (
    drawdownFromHigh <= -1
    && threeMinuteGain < 0
    && averageVolume(last3) > averageVolume(previous5) * 1.5
  )
  const lateSurge = (
    minuteOfDay(last.time) >= TAIL_PICK_WINDOW.closesAtMinute
    && threeMinuteGain >= 1.5
  )
  const blockers = []
  const evidence = []
  if (!latest5AboveVwap) blockers.push('最近5分钟没有持续站在分时均价线上方')
  else evidence.push('最近5分钟持续站在分时均价线上方')
  if (volumeDive) blockers.push('尾盘出现放量跳水')
  else evidence.push('未出现放量跳水')
  if (lateSurge) blockers.push('14:55后出现直线拉升，禁止追买')

  return {
    passed: blockers.length === 0,
    blockers,
    evidence,
    price: finite(last.price),
    vwap: finite(last.avg),
    low: Math.min(...prices),
    lastTime: String(last.time),
    latest5AboveVwap,
    volumeDive,
    lateSurge,
    threeMinuteGain: +threeMinuteGain.toFixed(2),
    drawdownFromHigh: +drawdownFromHigh.toFixed(2),
  }
}

export function evaluateTailPickStockGate({
  code = '',
  name = '',
  candles = [],
  quote = {},
  sectorOpportunity = null,
  intraday = null,
} = {}) {
  const blockers = []
  const evidence = []
  const normalizedCode = String(code)
  const normalizedName = String(name)
  if (
    /ST|退/.test(normalizedName.toUpperCase())
    || /^(68|8|4|9)/.test(normalizedCode)
  ) blockers.push('不在原公式允许的股票范围')
  if (candles.length < 31) blockers.push('历史行情不足31个交易日')
  const amount = finite(quote.amount ?? candles.at(-1)?.amount)
  if (amount == null || amount < 50_000_000) {
    blockers.push('当日成交额低于5000万元')
  } else {
    evidence.push('当日成交额达到5000万元')
  }
  const currentClose = finite(quote.price ?? candles.at(-1)?.close)
  const baseClose = finite(candles.at(-21)?.close)
  const gain20 = currentClose > 0 && baseClose > 0
    ? (currentClose / baseClose - 1) * 100
    : null
  if (gain20 == null) blockers.push('近20日位置数据不足')
  else if (gain20 > 35) blockers.push(`近20日已上涨${gain20.toFixed(1)}%，位置过高`)
  else evidence.push(`近20日涨幅${gain20.toFixed(1)}%，未超过35%`)

  if (
    !sectorOpportunity?.matched
    || !['LAYOUT', 'WAIT_PULLBACK'].includes(
      sectorOpportunity?.sector?.actionability,
    )
  ) {
    blockers.push('未进入板块前瞻确认的主线方向')
  } else {
    evidence.push(`属于${sectorOpportunity.sector.name}方向`)
  }
  if (!intraday?.passed) {
    blockers.push(...(intraday?.blockers || ['分时纪律未通过']))
  } else {
    evidence.push(...intraday.evidence)
  }
  return {
    passed: blockers.length === 0,
    blockers: [...new Set(blockers)],
    evidence: [...new Set(evidence)],
    gain20: gain20 == null ? null : +gain20.toFixed(2),
    amount,
    sourceVersion: TAIL_PICK_POLICY_VERSION,
  }
}

export function thirdTradingDayAfter(timestamp = Date.now()) {
  let cursor = timestamp
  let next = null
  for (let index = 0; index < 3; index++) {
    next = nextTradingDate(cursor)
    if (!next) return null
    cursor = next.getTime()
  }
  return next
}
