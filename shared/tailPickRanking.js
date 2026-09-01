import { thirdTradingDayAfter } from './tailPickPolicy.js'
import { localDateKey } from './tradingCalendar.js'

export const TAIL_PICK_RANKING_VERSION = 'tail-pick-ranking.v1'
export const TAIL_PICK_VALIDATION_STATE =
  'PENDING_INTRADAY_BACKTEST'

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

function candidateWarnings(candidate) {
  const warnings = [
    ...(candidate?.stockGate?.blockers || []),
  ]
  if (candidate?.stockGate?.passed === false && !warnings.length) {
    warnings.push('个股纪律检查未通过')
  }
  if (candidate?.intraday?.passed === false) {
    warnings.push(
      candidate.intraday.blockers?.[0] || '尾盘分时检查未通过',
    )
  }
  if (candidate?.sectorOpportunity?.matched === false) {
    warnings.push('未进入板块前瞻主线')
  }
  const fund = candidate?.fund
  const mainNow = finite(fund?.mainNetYi)
  const retailNow = finite(fund?.retailNetYi)
  const main5d = finite(fund?.main5dYi)
  const days = Number(fund?.historyDayCount) || 0
  if (!fund) warnings.push('资金数据缺失')
  else {
    if (days < 3) warnings.push(`资金历史仅${days}个交易日`)
    if (mainNow == null) warnings.push('当日主力资金缺失')
    if (retailNow == null) warnings.push('当日小单资金缺失')
    if (main5d == null) warnings.push('近期主力资金缺失')
    if (mainNow < 0 && retailNow > 0) {
      warnings.push('主力净流出且小单净流入')
    }
    if (main5d < 0) warnings.push('近期主力资金净流出')
  }
  return [...new Set(warnings.filter(Boolean))]
}

function instruction(
  candidate,
  role,
  timestamp,
  maxPositionPct,
) {
  const warnings = candidate.decisionWarnings || candidateWarnings(candidate)
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
      ? warnings.length
        ? `严格公式命中；另有${warnings.length}项风险提示，请结合计算结果自行判断`
        : `公式首选：不高于${ceiling ?? '--'}元观察，手工确认后最多${positionCap}%仓位`
      : `严格公式候补；${
          warnings.length ? `另有${warnings.length}项风险提示，` : ''
        }请结合计算结果自行判断`,
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
  const passed = Number(candidate.nearMatch?.passedCount) || 0
  const total = Number(candidate.nearMatch?.totalRuleCount) || 0
  const warnings = candidate.decisionWarnings || candidateWarnings(candidate)
  return {
    role: 'NEAR',
    action: `接近公式：通过${passed}/${total}项；${
      warnings.length ? `另有${warnings.length}项风险提示` : '其余检查无额外风险项'
    }，请自行判断`,
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
    timestamp = Date.now(),
    maxPositionPct = 5,
  } = {},
) {
  const ranked = candidates
    .filter((item) => item?.formula?.matched)
    .map((item) => ({
      ...item,
      decisionWarnings: candidateWarnings(item),
      ...candidateScore(item),
    }))
    .sort((left, right) =>
      Number(left.decisionWarnings.length)
        - Number(right.decisionWarnings.length)
      || Number(right.score) - Number(left.score)
      || Number(right.quote?.amount || 0)
        - Number(left.quote?.amount || 0)
      || String(left.code).localeCompare(String(right.code))
    )
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
) {
  return candidates
    .filter((item) => item?.nearMatch?.matched)
    .map((item) => ({
      ...item,
      decisionWarnings: candidateWarnings(item),
      ...nearCandidateScore(item),
    }))
    .sort((left, right) =>
      Number(left.nearMatch?.failedRules?.length || 99)
        - Number(right.nearMatch?.failedRules?.length || 99)
      || Number(left.decisionWarnings.length)
        - Number(right.decisionWarnings.length)
      || Number(right.score) - Number(left.score)
      || Number(right.quote?.amount || 0)
        - Number(left.quote?.amount || 0)
      || String(left.code).localeCompare(String(right.code))
    )
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      execution: nearInstruction(item),
    }))
}
