export const SECTOR_FORECAST_SORTS = Object.freeze([
  'rank',
  'conclusion',
  'score_desc',
  'score_asc',
])

const ACTION_ORDER = Object.freeze({
  LAYOUT: 0,
  WAIT_PULLBACK: 1,
  WATCH_ONLY: 2,
  AVOID: 3,
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
