export const SECTOR_FORECAST_SORTS = Object.freeze([
  'rank',
  'conclusion',
  'score_desc',
  'score_asc',
])

export function resolveSectorForecastGenerationSession(market = {}) {
  if (
    market?.phase === 'live'
    || market?.intradayAvailable === true
  ) return 'intraday'
  if (market?.phase === 'lunch') return 'intraday'
  if (market?.phase === 'preopen') return 'overnight'
  return 'close'
}

const ACTION_ORDER = Object.freeze({
  LAYOUT: 0,
  WAIT_PULLBACK: 1,
  WATCH_ONLY: 2,
  AVOID: 3,
})

const ACTION_VIEWS = Object.freeze({
  LAYOUT: Object.freeze({
    label: '可以买入',
    intent: 'buy',
    instruction:
      '可以小仓分批：优先核心或中军，下一交易日不高开再介入。',
  }),
  WAIT_PULLBACK: Object.freeze({
    label: '暂不买',
    intent: 'wait',
    instruction:
      '先不买：等缩量回踩企稳且资金继续流入，再考虑低吸。',
  }),
  WATCH_ONLY: Object.freeze({
    label: '不要买',
    intent: 'watch',
    instruction:
      '不要追：当前仅观察，等拥挤度下降或结构重新转强。',
  }),
  AVOID: Object.freeze({
    label: '回避',
    intent: 'avoid',
    instruction:
      '不买：资金或结构未通过风控闸门，暂时回避。',
  }),
})

const PHASE_ORDER = Object.freeze({
  ACCUMULATION: 0,
  STARTUP: 1,
  DIVERGENCE: 2,
  ACCELERATION: 3,
  RETREAT: 4,
})

function finiteValue(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rankValue(item, horizon) {
  return finiteValue(
    horizon === 'week' ? item?.weekRank : item?.rank,
  ) ?? 999
}

function scoreValue(item, horizon) {
  return finiteValue(item?.forecast?.[horizon]?.score)
}

function compareScore(left, right, horizon, direction) {
  const leftScore = scoreValue(left, horizon)
  const rightScore = scoreValue(right, horizon)
  if (leftScore === null && rightScore === null) return 0
  if (leftScore === null) return 1
  if (rightScore === null) return -1
  return (leftScore - rightScore) * direction
}

export function sectorForecastActionView(
  actionability,
  { session = 'close' } = {},
) {
  const base = ACTION_VIEWS[actionability] || {
    label: '待判断',
    intent: 'watch',
    instruction: '先不买：等待数据完整后再判断。',
  }
  if (session !== 'intraday') return base
  if (actionability === 'LAYOUT') {
    return {
      ...base,
      instruction:
        '可以小仓分批：优先核心或中军，盘中回踩不破且未明显冲高时介入。',
    }
  }
  if (actionability === 'WAIT_PULLBACK') {
    return {
      ...base,
      instruction:
        '先不买：等盘中缩量回踩企稳且资金继续流入，再考虑低吸。',
    }
  }
  return base
}

export function summarizeSectorForecastActions(items = []) {
  const rows = Array.isArray(items) ? items : []
  const counts = {
    buy: 0,
    wait: 0,
    watch: 0,
    avoid: 0,
  }
  const buyable = []
  for (const item of rows) {
    if (item?.actionability === 'LAYOUT') {
      counts.buy += 1
      buyable.push(item)
    } else if (item?.actionability === 'WAIT_PULLBACK') {
      counts.wait += 1
    } else if (item?.actionability === 'WATCH_ONLY') {
      counts.watch += 1
    } else {
      counts.avoid += 1
    }
  }
  return {
    counts,
    buyable,
    noBuy: counts.watch + counts.avoid,
  }
}

export function sortSectorForecasts(items = [], {
  horizon = 'next',
  sortMode = 'rank',
} = {}) {
  const mode = SECTOR_FORECAST_SORTS.includes(sortMode)
    ? sortMode
    : 'rank'
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .sort((leftEntry, rightEntry) => {
      const left = leftEntry.item
      const right = rightEntry.item
      if (mode === 'conclusion') {
        const actionDelta =
          (ACTION_ORDER[left?.actionability] ?? 99)
          - (ACTION_ORDER[right?.actionability] ?? 99)
        if (actionDelta) return actionDelta
        const phaseDelta =
          (PHASE_ORDER[left?.phase] ?? 99)
          - (PHASE_ORDER[right?.phase] ?? 99)
        if (phaseDelta) return phaseDelta
        const scoreDelta = compareScore(left, right, horizon, -1)
        if (scoreDelta) return scoreDelta
      } else if (mode === 'score_desc') {
        const scoreDelta = compareScore(left, right, horizon, -1)
        if (scoreDelta) return scoreDelta
      } else if (mode === 'score_asc') {
        const scoreDelta = compareScore(left, right, horizon, 1)
        if (scoreDelta) return scoreDelta
      }
      const rankDelta =
        rankValue(left, horizon) - rankValue(right, horizon)
      return rankDelta || leftEntry.index - rightEntry.index
    })
    .map((entry) => entry.item)
}
