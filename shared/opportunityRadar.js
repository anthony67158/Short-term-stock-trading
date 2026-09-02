import {
  beijingDate,
  beijingDayKey,
  isTradingDay,
  localDateKey,
  nextTradingDate,
} from './tradingCalendar.js'

export const OPPORTUNITY_RADAR_SCHEMA_VERSION =
  'opportunity-radar.v1'

const PHASES = Object.freeze({
  preopen: 'PREOPEN',
  live: 'INTRADAY',
  lunch: 'LUNCH',
  closed: 'AFTER_CLOSE',
})

const FORMULA_LABELS = Object.freeze({
  INTRADAY_VWAP_PULLBACK: '盘中回踩承接',
  INTRADAY_ACCUMULATION: '盘中资金先行',
  CLOSE_TREND_PULLBACK: '收盘趋势回踩',
  CLOSE_SQUEEZE: '收盘蓄势突破',
  TAIL_REVERSAL: '尾盘反转',
})

const STATE_ORDER = Object.freeze({
  READY: 0,
  WAIT_TRIGGER: 1,
  SECTOR_WATCH: 2,
  AVOID: 3,
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean).map(String))]
}

function tradingDayAfter(timestamp, count) {
  let cursor = Number(timestamp) || Date.now()
  let result = null
  for (let index = 0; index < count; index += 1) {
    result = nextTradingDate(cursor)
    if (!result) return null
    cursor = result.getTime()
  }
  return result ? localDateKey(result) : null
}

function previousTradingDayKey(timestamp) {
  const current = beijingDate(timestamp)
  current.setHours(0, 0, 0, 0)
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = new Date(current.getTime() - offset * 86400000)
    if (isTradingDay(candidate)) return localDateKey(candidate)
  }
  return ''
}

function sourceDay(value = {}) {
  return String(
    value?.tradeDate
    || value?.signalDate
    || value?.session?.tradeDate
    || '',
  )
}

function sourceState(value, {
  expectedDay = '',
  strictDay = false,
  error = '',
} = {}) {
  if (error) {
    return {
      status: 'failed',
      dataAsOf: null,
      tradeDate: null,
      error: String(error).slice(0, 180),
    }
  }
  if (!value) return { status: 'missing', dataAsOf: null }
  const day = sourceDay(value)
  return {
    status: strictDay && expectedDay && day !== expectedDay
      ? 'stale'
      : 'fresh',
    dataAsOf:
      value.dataAsOf
      ?? value.generatedAt
      ?? value.session?.dataAsOf
      ?? null,
    tradeDate: day || null,
  }
}

function sectorSnapshotFor(sector, phase, day) {
  const intraday = sector?.intraday
  if (
    ['INTRADAY', 'LUNCH'].includes(phase)
    && intraday?.signalDate === day
  ) return intraday
  return sector?.latest || intraday || null
}

function sectorView(value = {}) {
  return {
    code: String(value.code || ''),
    name: String(value.name || ''),
    phase: String(value.phase || ''),
    actionability: String(value.actionability || ''),
    rank: finite(value.rank),
    layoutRank: finite(value.layoutRank),
    layoutScore: finite(value.timing?.layoutScore),
    nextScore: finite(value.forecast?.next?.score),
  }
}

function sectorMaps(snapshot) {
  const sectors = Array.isArray(snapshot?.sectors)
    ? snapshot.sectors
    : []
  return {
    sectors,
    byCode: new Map(
      sectors
        .filter((item) => item?.code)
        .map((item) => [String(item.code), item]),
    ),
    byName: new Map(
      sectors
        .filter((item) => item?.name)
        .map((item) => [String(item.name), item]),
    ),
  }
}

function resolveCandidateSector(candidate = {}, maps) {
  const value = candidate.sector || {}
  return maps.byCode.get(String(value.code || ''))
    || maps.byName.get(String(value.name || ''))
    || value
}

function formulaEntryPlan(candidate, lane) {
  const price = finite(candidate.primaryPrice)
  if (price == null) return null
  const pullback = candidate.priceType === 'PULLBACK_WATCH'
  const nextSession = lane === 'next'
  return {
    type: pullback ? 'PULLBACK' : 'BREAKOUT',
    price,
    window: nextSession
      ? '下一交易日开盘确认后'
      : '当前连续竞价时段',
    trigger: pullback
      ? '回踩观察价后重新站稳，且资金承接未转弱'
      : '放量突破观察价并保持站稳',
    maxPositionPct: 5,
    validUntil: finite(candidate.validUntil),
  }
}

function formulaExitPlan(candidate, lane, now) {
  const stop = finite(candidate.stopPrice)
  const target = finite(candidate.targetPrice)
  if (stop == null || target == null) return null
  return {
    hardStopPrice: stop,
    takeProfitPrice: target,
    timeStopDate: tradingDayAfter(now, 5),
    rule: lane === 'intraday'
      ? '目标或止损先到先执行；第3个交易日未脱离成本区则减仓，第5个交易日仍未走强则退出'
      : '次日确认后生效；目标或止损先到先执行，第5个交易日仍未走强则退出',
    t1Constraint:
      '当日买入不可卖出，下一可卖时段优先处理风险',
  }
}

function formulaOpportunity(candidate, {
  lane,
  sourceFresh,
  sectorFresh,
  maps,
  now,
}) {
  const sector = resolveCandidateSector(candidate, maps)
  const entryPlan = formulaEntryPlan(candidate, lane)
  const exitPlan = formulaExitPlan(candidate, lane, now)
  const riskReward = finite(candidate.riskReward)
  const blockers = [...(candidate.blockers || [])]
  if (riskReward == null || riskReward < 1.8) {
    blockers.push('盈亏比不足1.8:1')
  }
  if (!entryPlan || !exitPlan) blockers.push('买卖价格合同不完整')
  if (!sourceFresh) blockers.push('公式结果已过期')
  if (
    lane === 'intraday'
    && finite(candidate.validUntil) != null
    && Number(candidate.validUntil) < Number(now)
  ) blockers.push('公式观察时段已结束')
  const sectorAction = String(sector?.actionability || '')
  if (!['LAYOUT', 'WAIT_PULLBACK'].includes(sectorAction)) {
    blockers.push('板块方向尚未支持新增仓位')
  }
  const hardBlocked = blockers.length > 0
  if (!sectorFresh) blockers.push('板块方向需要重新确认')
  const current = finite(candidate.quote?.price)
  const distance = current != null && entryPlan?.price > 0
    ? Math.abs(current / entryPlan.price - 1) * 100
    : null
  const ready = (
    lane !== 'next'
    && sectorAction === 'LAYOUT'
    && sectorFresh
    && distance != null
    && distance <= 0.8
    && !hardBlocked
  )
  const valid = !hardBlocked
  return {
    code: String(candidate.code || ''),
    name: String(candidate.name || ''),
    lane,
    state: ready ? 'READY' : valid ? 'WAIT_TRIGGER' : 'AVOID',
    stateLabel: ready
      ? '当前可关注'
      : valid
        ? '等待触发'
        : '暂不操作',
    sector: sectorView(sector),
    quote: candidate.quote || null,
    score: finite(candidate.score),
    riskReward,
    entryPlan,
    exitPlan,
    sourceSignals: unique([
      sector?.name ? '板块前瞻' : null,
      FORMULA_LABELS[candidate.formulaId] || candidate.formulaId,
    ]),
    evidence: unique(candidate.evidence || []),
    blockers: unique(blockers),
    stale: !sourceFresh,
    _decisionPriority: 2,
  }
}

function tailOpportunity(candidate, {
  near = false,
  formal = false,
  sourceFresh,
  maps,
  now,
}) {
  const sector = resolveCandidateSector(candidate, maps)
  const execution = candidate.execution || {}
  const entryPrice = finite(candidate.quote?.price)
  const stop = finite(execution.stopPrice)
  const blockers = unique([
    ...(candidate.blockers || []),
    ...(candidate.decisionWarnings || []),
    ...(near
      ? (candidate.nearMatch?.failedRules || [])
          .map((item) => item?.label)
      : []),
  ])
  if (near) blockers.unshift('仅接近公式，尚未完整命中')
  if (!formal) blockers.push('手动试算仅供观察')
  if (!sourceFresh) blockers.push('尾盘结果已过期')
  if (!near && (entryPrice == null || stop == null)) {
    blockers.push('尾盘买卖计划不完整')
  }
  const valid = !near
    && formal
    && sourceFresh
    && entryPrice != null
    && stop != null
    && execution.finalExitDate
  const ready = valid && candidate.liveStatus === 'READY'
  return {
    code: String(candidate.code || ''),
    name: String(candidate.name || ''),
    lane: 'next',
    state: ready ? 'READY' : valid ? 'WAIT_TRIGGER' : 'AVOID',
    stateLabel: ready
      ? '尾盘可关注'
      : valid
        ? '次日重点关注'
        : '仅作参考',
    sector: sectorView(sector),
    quote: candidate.quote || null,
    score: finite(candidate.score),
    riskReward: null,
    entryPlan: valid
      ? {
          type: 'TAIL_REVERSAL',
          price: entryPrice,
          window: '14:50-14:55确认，次日按计划处理',
          trigger: unique([
            execution.firstLeg,
            execution.secondLeg,
          ]).join('；') || execution.action || '尾盘结构确认后介入',
          maxPositionPct:
            Math.min(5, Math.max(0, finite(execution.maxPositionPct) || 5)),
          validUntil: null,
        }
      : null,
    exitPlan: valid
      ? {
          hardStopPrice: stop,
          takeProfitPrice: null,
          timeStopDate:
            execution.finalExitDate || tradingDayAfter(now, 3),
          rule:
            execution.takeProfit
            || '次日冲高分批止盈，最晚第3个交易日退出',
          t1Constraint:
            execution.stopNote
            || '当日买入不可卖出，下一可卖时段优先处理风险',
        }
      : null,
    sourceSignals: unique([
      sector?.name ? '板块前瞻' : null,
      near ? '尾盘接近公式' : '尾盘反转',
    ]),
    evidence: unique(candidate.evidence || []),
    blockers,
    stale: !sourceFresh,
    _decisionPriority: near ? 1 : 3,
  }
}

function sectorOpportunity(sector, stock, lane) {
  const value = sectorView(sector)
  return {
    code: String(stock?.code || ''),
    name: String(stock?.name || ''),
    lane,
    state: 'SECTOR_WATCH',
    stateLabel: '方向可看，尚无买点',
    sector: value,
    quote: {
      price: finite(stock?.price),
      pct: finite(stock?.pct),
    },
    score:
      finite(stock?.layoutScore)
      ?? finite(stock?.score)
      ?? value.layoutScore
      ?? value.nextScore,
    riskReward: null,
    entryPlan: null,
    exitPlan: null,
    sourceSignals: ['板块前瞻'],
    evidence: unique([
      stock?.entryLabel,
      ...(sector?.reasons || []),
    ]),
    blockers: ['尚无个股价格合同'],
    stale: false,
    _decisionPriority: 0,
  }
}

function mergeOpportunity(left, right) {
  if (!left) return right
  const primary = Number(right._decisionPriority || 0)
    >= Number(left._decisionPriority || 0)
    ? right
    : left
  const secondary = primary === right ? left : right
  return {
    ...secondary,
    ...primary,
    sector: primary.sector?.code || primary.sector?.name
      ? primary.sector
      : secondary.sector,
    sourceSignals: unique([
      ...(left.sourceSignals || []),
      ...(right.sourceSignals || []),
    ]),
    evidence: unique([
      ...(left.evidence || []),
      ...(right.evidence || []),
    ]).slice(0, 6),
    blockers: unique([
      ...(primary.blockers || []),
      ...(secondary.blockers || []).filter(
        (item) => item !== '尚无个股价格合同',
      ),
    ]),
  }
}

function sectorRows(snapshot, lane) {
  const sectors = Array.isArray(snapshot?.sectors)
    ? snapshot.sectors
    : []
  return sectors
    .filter((sector) => {
      if (lane === 'layout') {
        return (
          sector?.timing?.lane === 'EARLY_LAYOUT'
          || sector?.phase === 'ACCUMULATION'
        )
      }
      return ['LAYOUT', 'WAIT_PULLBACK'].includes(
        sector?.actionability,
      )
    })
    .slice(0, 5)
    .flatMap((sector) =>
      (Array.isArray(sector?.stocks) ? sector.stocks : [])
        .slice(0, 3)
        .map((stock) => sectorOpportunity(sector, stock, lane)),
    )
}

function sortedRows(rows) {
  return [...rows]
    .sort((left, right) =>
      (STATE_ORDER[left.state] ?? 99) - (STATE_ORDER[right.state] ?? 99)
      || Number(left.blockers?.length || 0)
        - Number(right.blockers?.length || 0)
      || Number(right.score || 0) - Number(left.score || 0)
      || Number(left.sector?.layoutRank || left.sector?.rank || 999)
        - Number(right.sector?.layoutRank || right.sector?.rank || 999)
      || Number(right.quote?.amount || 0)
        - Number(left.quote?.amount || 0)
      || String(left.code).localeCompare(String(right.code))
    )
    .map(({ _decisionPriority, ...item }) => item)
}

function mergeLane(rows) {
  const merged = new Map()
  for (const row of rows.filter((item) => item?.code)) {
    merged.set(row.code, mergeOpportunity(merged.get(row.code), row))
  }
  return sortedRows([...merged.values()])
}

function summaryFor(rows) {
  const summary = {
    ready: 0,
    waiting: 0,
    sectorWatch: 0,
    avoid: 0,
  }
  for (const row of rows) {
    if (row.state === 'READY') summary.ready += 1
    else if (row.state === 'WAIT_TRIGGER') summary.waiting += 1
    else if (row.state === 'SECTOR_WATCH') summary.sectorWatch += 1
    else summary.avoid += 1
  }
  return summary
}
export function resolveOpportunityRadarPhase({
  market = {},
} = {}) {
  const phase = PHASES[market?.phase]
    || (market?.tradingDay === false ? 'REST' : 'AFTER_CLOSE')
  return {
    phase,
    defaultLane: phase === 'INTRADAY' || phase === 'LUNCH'
      ? 'intraday'
      : 'next',
  }
}

export function buildOpportunityRadar({
  sector = {},
  formula = {},
  tail = null,
  sourceErrors = {},
  now = Date.now(),
} = {}) {
  const timestamp = Number(now) || Date.now()
  const timing = resolveOpportunityRadarPhase({
    market: sector?.market,
    now: timestamp,
  })
  const day = String(sector?.market?.day || beijingDayKey(timestamp))
  const closeDay = (
    timing.phase === 'AFTER_CLOSE'
    && sector?.market?.tradingDay !== false
  ) ? day : previousTradingDayKey(timestamp)
  const sectorSnapshot = sectorSnapshotFor(
    sector,
    timing.phase,
    day,
  )
  const maps = sectorMaps(sectorSnapshot)
  const tailState = tail || null
  const tailResult = tailState?.currentResult
    || tailState?.latest
    || tailState?.displayResult
    || tailState
    || formula?.tail
    || null
  const sourceStatus = {
    sector: sourceState(sectorSnapshot, {
      expectedDay: sectorSnapshot?.session === 'intraday'
        ? day
        : closeDay,
      strictDay: true,
      error: sourceErrors.sector,
    }),
    formulaIntraday: sourceState(formula?.intraday, {
      expectedDay: day,
      strictDay: true,
      error: sourceErrors.formula,
    }),
    formulaClose: sourceState(formula?.close, {
      expectedDay: closeDay,
      strictDay: true,
      error: sourceErrors.formula,
    }),
    tail: sourceState(tailResult, {
      expectedDay: closeDay,
      strictDay: true,
      error: sourceErrors.tail,
    }),
  }
  const intradayFormula = Array.isArray(formula?.intraday?.candidates)
    ? formula.intraday.candidates
    : []
  const closeFormula = Array.isArray(formula?.close?.candidates)
    ? formula.close.candidates
    : []
  const tailCandidates = Array.isArray(tailResult?.result?.candidates)
    ? tailResult.result.candidates
    : []
  const tailNearCandidates =
    Array.isArray(tailResult?.result?.nearCandidates)
      ? tailResult.result.nearCandidates
      : []
  const preferredFormula = ['INTRADAY', 'LUNCH'].includes(timing.phase)
    ? intradayFormula
    : closeFormula
  const preferredFormulaFresh =
    ['INTRADAY', 'LUNCH'].includes(timing.phase)
      ? sourceStatus.formulaIntraday.status === 'fresh'
      : sourceStatus.formulaClose.status === 'fresh'

  const layout = mergeLane([
    ...sectorRows(sectorSnapshot, 'layout'),
    ...preferredFormula
      .filter((candidate) =>
        candidate?.sector?.actionability === 'LAYOUT',
      )
      .map((candidate) => formulaOpportunity(candidate, {
        lane: 'layout',
        sourceFresh: preferredFormulaFresh,
        sectorFresh: sourceStatus.sector.status === 'fresh',
        maps,
        now: timestamp,
      })),
  ])
  const intraday = mergeLane([
    ...sectorRows(sectorSnapshot, 'intraday'),
    ...intradayFormula.map((candidate) =>
      formulaOpportunity(candidate, {
        lane: 'intraday',
        sourceFresh:
          sourceStatus.formulaIntraday.status === 'fresh',
        sectorFresh: sourceStatus.sector.status === 'fresh',
        maps,
        now: timestamp,
      }),
    ),
  ])
  const next = mergeLane([
    ...sectorRows(sector?.latest || sectorSnapshot, 'next'),
    ...closeFormula.map((candidate) =>
      formulaOpportunity(candidate, {
        lane: 'next',
        sourceFresh: sourceStatus.formulaClose.status === 'fresh',
        sectorFresh: sourceStatus.sector.status === 'fresh',
        maps: sectorMaps(sector?.latest || sectorSnapshot),
        now: timestamp,
      }),
    ),
    ...tailCandidates.map((candidate) =>
      tailOpportunity(candidate, {
        formal: tailResult?.session?.isFormal === true,
        sourceFresh: sourceStatus.tail.status === 'fresh',
        maps: sectorMaps(sector?.latest || sectorSnapshot),
        now: timestamp,
      }),
    ),
    ...tailNearCandidates.map((candidate) =>
      tailOpportunity(candidate, {
        near: true,
        formal: tailResult?.session?.isFormal === true,
        sourceFresh: sourceStatus.tail.status === 'fresh',
        maps: sectorMaps(sector?.latest || sectorSnapshot),
        now: timestamp,
      }),
    ),
  ])
  const lanes = { layout, intraday, next }
  return {
    schemaVersion: OPPORTUNITY_RADAR_SCHEMA_VERSION,
    generatedAt: timestamp,
    ...timing,
    market: sector?.market || null,
    settings: sector?.settings || null,
    tailSession: tailState?.session || null,
    sourceStatus,
    tasks: {
      sector: sector?.task || null,
      formulaIntraday: formula?.progress?.intraday || null,
      formulaClose: formula?.progress?.close || null,
      tail: tailState?.task || null,
    },
    lanes,
    sectors: maps.sectors.slice(0, 5).map(sectorView),
    summary: summaryFor(lanes[timing.defaultLane]),
  }
}
