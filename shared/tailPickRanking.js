import { thirdTradingDayAfter } from './tailPickPolicy.js'
import { localDateKey } from './tradingCalendar.js'

export const TAIL_PICK_RANKING_VERSION = 'tail-pick-ranking.v1'
export const TAIL_PICK_VALIDATION_STATE =
  'PENDING_INTRADAY_BACKTEST'
export const TAIL_PICK_NEAR_LIMIT = 5

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function fundScore(fund) {
  if (!fund) return { score: 0, label: '资金数据缺失' }
  const mainNow = finite(fund.mainNetYi)
  const retailNow = finite(fund.retailNetYi)
  const main5d = finite(fund.main5dYi)
  let score = 0
  if (mainNow > 0) score += 6
  else if (mainNow < 0) score -= 6
  if (main5d > 0) score += 8
  else if (main5d < 0) score -= 8
  if (mainNow < 0 && retailNow > 0) score -= 8
  if (mainNow > 0 && retailNow < 0) score += 2
  const days = Number(fund.historyDayCount) || 0
  const range = days >= 5 ? '近5日' : `近${days}日`
  const mainText = mainNow == null
    ? '主力缺失'
    : `主力${mainNow >= 0 ? '净流入' : '净流出'}${Math.abs(mainNow)}亿`
  const retailText = retailNow == null
    ? '小单缺失'
    : `小单${retailNow >= 0 ? '净流入' : '净流出'}${Math.abs(retailNow)}亿`
  return {
    score,
    label: `${range}资金；当日${mainText}，${retailText}`,
  }
}

function candidateScore(candidate) {
  const sector = candidate.sectorOpportunity || {}
  const intraday = candidate.intraday || {}
  const stockGate = candidate.stockGate || {}
  const fund = fundScore(candidate.fund)
  const sectorScore = finite(sector.sector?.nextScore) || 0
  const stockScore = finite(sector.stock?.score) || 0
  const gain20 = finite(stockGate.gain20) || 0
  const vwapDistance = intraday.vwap > 0
    ? (intraday.price / intraday.vwap - 1) * 100
    : 0
  return {
    score: rounded(clamp(
      45
        + sectorScore * 0.25
        + stockScore * 0.15
        + fund.score
        + clamp(12 - Math.max(0, gain20) * 0.3, 0, 12)
        + clamp(8 - Math.abs(vwapDistance - 0.4) * 4, 0, 8),
    ), 1),
    fundLabel: fund.label,
  }
}

function nearCandidateScore(candidate) {
  const matchRate = finite(candidate.nearMatch?.matchRate) || 0
  const fund = fundScore(candidate.fund)
  const contextBonus =
    (candidate.stockGate?.passed ? 4 : 0)
    + (candidate.intraday?.passed ? 3 : 0)
    + (candidate.sectorOpportunity?.matched ? 3 : 0)
  return {
    score: rounded(clamp(
      matchRate + contextBonus + clamp(fund.score, -5, 5),
    ), 1),
    fundLabel: fund.label,
  }
}

function hasNearFundSupport(fund) {
  const mainNow = finite(fund?.mainNetYi)
  const retailNow = finite(fund?.retailNetYi)
  const main5d = finite(fund?.main5dYi)
  const days = Number(fund?.historyDayCount) || 0
  return (
    days >= 3
    && mainNow != null
    && retailNow != null
    && main5d != null
    && !(mainNow < 0 && retailNow > 0)
    && (mainNow > 0 || main5d > 0)
  )
}

function instruction(
  candidate,
  role,
  timestamp,
  maxPositionPct,
) {
  const price = finite(candidate.intraday?.price)
    ?? finite(candidate.quote?.price)
  const vwap = finite(candidate.intraday?.vwap)
  const dayLow = finite(candidate.quote?.low)
    ?? finite(candidate.intraday?.low)
  const ceiling = price == null
    ? null
    : rounded(Math.max(price, vwap || price) * 1.003)
  const positionCap = Math.max(
    1,
    Math.min(5, Number(maxPositionPct) || 5),
  )
  const firstLegPct = Math.min(2, positionCap)
  const secondLegPct = Math.max(0, positionCap - firstLegPct)
  const finalExit = thirdTradingDayAfter(timestamp)
  return {
    role,
    action: role === 'PRIMARY'
      ? `公式首选：不高于${ceiling ?? '--'}元观察，手工确认后最多${positionCap}%仓位`
      : '候补：首选失效前不买，只加入自选跟踪',
    firstLeg: role === 'PRIMARY'
      ? `14:50-14:52不高于${ceiling ?? '--'}元，第一笔最多${firstLegPct}%`
      : null,
    secondLeg: role === 'PRIMARY'
      ? secondLegPct > 0
        ? `14:53-14:55仍站稳分时均价线且未放量跳水，再补最多${secondLegPct}%`
        : null
      : null,
    maxPositionPct: positionCap,
    stopPrice: rounded(dayLow),
    stopNote: '买入当日最低价，次日起生效',
    takeProfit: '次日冲高1%-3%减半，累计上涨7%-8%清仓',
    finalExitDate: finalExit ? localDateKey(finalExit) : null,
  }
}

function nearInstruction(candidate) {
  const missing = (candidate.nearMatch?.failedRules || [])
    .map((item) => item.label)
    .filter(Boolean)
  return {
    role: 'NEAR',
    action: `接近公式：还差${missing.join('、') || '部分条件'}，条件补齐前不买`,
    firstLeg: null,
    secondLeg: null,
    maxPositionPct: 0,
    stopPrice: null,
    stopNote: null,
    takeProfit: null,
    finalExitDate: null,
  }
}

export function rankTailPickCandidates(
  candidates = [],
  {
    limit = 3,
    timestamp = Date.now(),
    maxPositionPct = 5,
  } = {},
) {
  const ranked = candidates
    .filter((item) =>
      item?.formula?.matched
      && item?.stockGate?.passed
      && item?.intraday?.passed
    )
    .map((item) => ({
      ...item,
      ...candidateScore(item),
    }))
    .sort((left, right) =>
      Number(right.score) - Number(left.score)
      || Number(right.quote?.amount || 0)
        - Number(left.quote?.amount || 0)
      || String(left.code).localeCompare(String(right.code))
    )
    .slice(0, Math.max(0, Math.min(3, Number(limit) || 3)))
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      execution: instruction(
        item,
        index === 0 ? 'PRIMARY' : 'ALTERNATE',
        timestamp,
        maxPositionPct,
      ),
    }))
  return {
    schemaVersion: TAIL_PICK_RANKING_VERSION,
    validationState: TAIL_PICK_VALIDATION_STATE,
    decision: ranked.length ? 'OBSERVE_ONLY' : 'NO_TRADE',
    primaryCode: ranked[0]?.code || null,
    candidates: ranked,
  }
}

export function rankTailPickNearCandidates(
  candidates = [],
  { limit = TAIL_PICK_NEAR_LIMIT } = {},
) {
  return candidates
    .filter((item) =>
      item?.nearMatch?.matched
      && item?.stockGate?.passed
      && finite(item?.stockGate?.gain20) != null
      && finite(item.stockGate.gain20) <= 35
      && hasNearFundSupport(item.fund)
    )
    .map((item) => ({
      ...item,
      ...nearCandidateScore(item),
    }))
    .sort((left, right) =>
      Number(left.nearMatch?.failedRules?.length || 99)
        - Number(right.nearMatch?.failedRules?.length || 99)
      || Number(right.stockGate?.passed) - Number(left.stockGate?.passed)
      || Number(right.intraday?.passed) - Number(left.intraday?.passed)
      || Number(right.score) - Number(left.score)
      || Number(right.quote?.amount || 0)
        - Number(left.quote?.amount || 0)
      || String(left.code).localeCompare(String(right.code))
    )
    .slice(
      0,
      Math.max(
        0,
        Math.min(TAIL_PICK_NEAR_LIMIT, Number(limit) || TAIL_PICK_NEAR_LIMIT),
      ),
    )
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      execution: nearInstruction(item),
    }))
}
