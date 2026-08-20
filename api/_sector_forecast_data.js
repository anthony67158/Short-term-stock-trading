import {
  buildSectorForecastFeatures,
  rankSectorForecasts,
  scoreSectorForecast,
  SECTOR_FORECAST_SCHEMA_VERSION,
} from '../shared/sectorForecast.js'
import {
  identifyConceptLeaders,
} from '../shared/conceptLeadership.js'
import {
  parseSectorFlowRows,
  selectLongestKlines,
} from '../shared/sectorFlowHistory.js'
import {
  emGet,
  emGetAll,
  emGetOne,
} from './_lib.js'
import {
  collectSectorRows,
  mapSectorRow,
} from './sectors.js'
import { mapStockRow } from './stocks.js'

const clamp = (value, low = 0, high = 100) =>
  Math.max(low, Math.min(high, Number(value) || 0))

const rounded = (value, digits = 2) =>
  Number.isFinite(Number(value))
    ? +Number(value).toFixed(digits)
    : null

const finiteOptional = (value) =>
  value !== null
  && value !== undefined
  && value !== ''
  && Number.isFinite(Number(value))

export function sectorProbabilityScore(value) {
  if (!Number.isFinite(Number(value))) return null
  return rounded(
    clamp(50 + (Number(value) - 20) * 2.5),
    1,
  )
}

function percentile(value, values = []) {
  const usable = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (!usable.length) return 0
  if (usable.length === 1) return 1
  let index = 0
  for (let cursor = 0; cursor < usable.length; cursor++) {
    if (usable[cursor] <= Number(value)) index = cursor
  }
  return index / (usable.length - 1)
}

function sectorPercentiles(sector, sectors) {
  return {
    mainInflow: percentile(
      sector.mainInflow,
      sectors.map((item) => item.mainInflow),
    ),
    mainRatio: percentile(
      sector.mainRatio,
      sectors.map((item) => item.mainRatio),
    ),
    amount: percentile(
      sector.amount,
      sectors.map((item) => item.amount),
    ),
    pct: percentile(
      sector.pct,
      sectors.map((item) => item.pct),
    ),
    leadPct: percentile(
      sector.leadPct,
      sectors.map((item) => item.leadPct),
    ),
  }
}

function universeScore(sector, sectors) {
  const ranks = sectorPercentiles(sector, sectors)
  const currentPct = Math.abs(Number(sector.pct) || 0)
  const lowMoveScore = clamp(100 - currentPct * 12)
  const crowdingPenalty = currentPct >= 7
    ? 30
    : currentPct >= 5 ? 15 : 0
  return rounded(
    ranks.mainInflow * 45
      + ranks.mainRatio * 25
      + ranks.amount * 15
      + lowMoveScore * 0.15
      - crowdingPenalty,
    2,
  )
}

export function selectSectorForecastUniverse(rows = [], limit = 24) {
  const valid = (Array.isArray(rows) ? rows : []).filter((item) =>
    /^BK\d{4}$/.test(String(item?.code || ''))
    && String(item?.name || '').trim()
    && Number.isFinite(Number(item?.mainInflow))
    && Number.isFinite(Number(item?.mainRatio))
    && Number(item?.amount) > 0
  )
  return valid
    .map((item) => ({
      ...item,
      universeScore: universeScore(item, valid),
    }))
    .sort((left, right) =>
      right.universeScore - left.universeScore
      || Number(right.mainInflow) - Number(left.mainInflow)
      || String(left.code).localeCompare(String(right.code))
    )
    .slice(0, Math.max(1, Math.min(60, Number(limit) || 24)))
}

function marketContext(sectors) {
  const rows = (Array.isArray(sectors) ? sectors : [])
    .filter((item) => Number.isFinite(Number(item?.pct)))
  const upPct = rows.length
    ? rows.filter((item) => Number(item.pct) > 0).length / rows.length * 100
    : 50
  const averagePct = rows.length
    ? rows.reduce((sum, item) => sum + Number(item.pct), 0) / rows.length
    : 0
  const score = clamp(50 + (upPct - 50) * 0.4 + averagePct * 3)
  return {
    score: rounded(score, 1),
    riskState: score >= 62
      ? 'RISK_ON'
      : score <= 38 ? 'RISK_OFF' : 'NEUTRAL',
  }
}

function memberBreadth(rows = []) {
  const members = (Array.isArray(rows) ? rows : []).filter((item) =>
    /^\d{6}$/.test(String(item?.code || ''))
  )
  const ratio = (predicate) => members.length
    ? members.filter(predicate).length / members.length * 100
    : 0
  return {
    upPct: rounded(ratio((item) => Number(item.pct) > 0)),
    inflowPct: rounded(ratio((item) => Number(item.mainInflow) > 0)),
    limitUpPct: rounded(ratio((item) => item.isLimitUp === true)),
    memberCount: members.length,
  }
}

function historyWithCurrent(history, sector, signalDate) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((item) => item?.date)
    .slice()
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
  const current = {
    date: signalDate,
    close: Number(sector.price) || rows.at(-1)?.close || null,
    pct: Number(sector.pct) || 0,
    mainInflow: Number(sector.mainInflow) || 0,
    mainRatio: Number(sector.mainRatio) || 0,
  }
  const index = rows.findIndex((item) => item.date === signalDate)
  if (index >= 0) rows[index] = { ...rows[index], ...current }
  else rows.push(current)
  return rows.slice(-30)
}

function leadershipContext(sector, memberRows) {
  const leaders = identifyConceptLeaders(
    {
      ...sector,
      conceptStrength: clamp(sector.universeScore),
      conceptRank: 0,
    },
    memberRows,
  )
  const lead = leaders[0]
  const core = leaders.find((item) =>
    item.conceptLeadership?.role === 'core'
  )
  return {
    leaders,
    strength: rounded(
      Math.max(
        Number(lead?.conceptLeadership?.leaderScore) || 0,
        Number(sector.universeScore) || 0,
      ),
      1,
    ),
    coreHealthy: !!(
      core
      && Number(core.mainInflow) > 0
      && Number(core.pct) > -2
    ),
  }
}

function stockView(item) {
  return {
    code: String(item.code),
    name: String(item.name || ''),
    role: item.conceptLeadership?.role || 'follower',
    roleLabel: item.conceptLeadership?.roleLabel || '成分股',
    score: rounded(item.conceptLeadership?.leaderScore, 1),
    price: rounded(item.price),
    pct: rounded(item.pct),
    mainInflow: rounded(item.mainInflow, 0),
    mainRatio: rounded(item.mainRatio),
  }
}

export function buildSectorForecastSnapshot({
  signalDate,
  generatedAt = Date.now(),
  sectors = [],
  histories = new Map(),
  members = new Map(),
  quantPredictions = new Map(),
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(signalDate || ''))) {
    throw new Error('板块前瞻缺少有效signalDate')
  }
  const market = marketContext(sectors)
  const forecasts = sectors.map((sector) => {
    const memberRows = members instanceof Map
      ? (members.get(String(sector.code)) || [])
      : (members?.[sector.code] || [])
    const history = histories instanceof Map
      ? (histories.get(String(sector.code)) || [])
      : (histories?.[sector.code] || [])
    const leadership = leadershipContext(sector, memberRows)
    const features = buildSectorForecastFeatures({
      sector,
      history: historyWithCurrent(history, sector, signalDate),
      sectorPercentiles: sectorPercentiles(sector, sectors),
      breadth: memberBreadth(memberRows),
      leadership,
      market,
    })
    const baseline = scoreSectorForecast(features)
    const quant = quantPredictions instanceof Map
      ? quantPredictions.get(String(sector.code))
      : quantPredictions?.[sector.code]
    const nextProbability = finiteOptional(quant?.nextProbability)
      ? clamp(Number(quant.nextProbability))
      : null
    const weekProbability = finiteOptional(quant?.weekProbability)
      ? clamp(Number(quant.weekProbability))
      : null
    const nextModelScore = sectorProbabilityScore(nextProbability)
    const weekModelScore = sectorProbabilityScore(weekProbability)
    const nextScore = nextProbability === null
      ? baseline.forecast.next.score
      : rounded(
          baseline.forecast.next.score * 0.45
            + nextModelScore * 0.55,
          1,
        )
    const weekScore = weekProbability === null
      ? baseline.forecast.week.score
      : rounded(
          baseline.forecast.week.score * 0.45
            + weekModelScore * 0.55,
          1,
        )
    const modelProbabilities = [
      nextProbability,
      weekProbability,
    ].filter((value) => value !== null)
    const maximumProbability = modelProbabilities.length
      ? Math.max(...modelProbabilities)
      : null
    let actionability = baseline.actionability
    if (
      actionability === 'LAYOUT'
      && maximumProbability !== null
      && maximumProbability < 26
    ) actionability = 'WAIT_PULLBACK'
    if (
      !['AVOID', 'WATCH_ONLY'].includes(actionability)
      && maximumProbability !== null
      && maximumProbability < 16
    ) actionability = 'WATCH_ONLY'
    return {
      ...baseline,
      actionability,
      breadth: features.breadth,
      raw: features.raw,
      forecast: {
        next: {
          ...baseline.forecast.next,
          score: nextScore,
          probability: nextProbability,
        },
        week: {
          ...baseline.forecast.week,
          score: weekScore,
          probability: weekProbability,
          drawdownEstimate: Number.isFinite(
            Number(quant?.drawdownEstimate),
          )
            ? rounded(Number(quant.drawdownEstimate), 2)
            : null,
        },
      },
      stocks: leadership.leaders.slice(0, 3).map(stockView),
    }
  })
  const nextRanked = rankSectorForecasts(forecasts, 'next')
  const weekRanks = new Map(
    rankSectorForecasts(forecasts, 'week')
      .map((item) => [item.code, item.rank]),
  )
  return {
    schemaVersion: SECTOR_FORECAST_SCHEMA_VERSION,
    signalDate,
    session: 'close',
    generatedAt: Number(generatedAt) || Date.now(),
    dataAsOf: nextRanked
      .map((item) => item.dataAsOf)
      .filter(Boolean)
      .sort()
      .at(-1) || signalDate,
    model: {
      deterministic: SECTOR_FORECAST_SCHEMA_VERSION,
      quant: (
        quantPredictions instanceof Map
          ? quantPredictions.size > 0
          : Object.keys(quantPredictions || {}).length > 0
      ) ? 'lightgbm' : 'unavailable',
    },
    market,
    sectors: nextRanked.map((item) => ({
      ...item,
      weekRank: weekRanks.get(item.code) || null,
    })),
  }
}

async function fetchConceptRows() {
  const fields =
    'f12,f14,f2,f3,f62,f184,f66,f72,f78,f84,f128,f140,f136,f8,f6'
  const fetchPage = (page) => emGetOne(
    `/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2`
      + `&fid=f62&fs=${encodeURIComponent('m:90+t:3')}`
      + `&fields=${fields}`,
    { hostIndex: 2, maxAttempts: 3 },
  )
  return (await collectSectorRows(fetchPage)).map(mapSectorRow)
}

async function fetchSectorHistory(code, days = 30) {
  const path =
    `/api/qt/stock/fflow/daykline/get?lmt=${days}&klt=101`
    + `&ut=b2884a393a59ad64002292a3e90d46a5`
    + `&fields1=f1,f2,f3,f7`
    + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`
    + `&secid=90.${code}&_=${Date.now()}`
  let payloads = await emGetAll(path, { his: true }).catch(() => [])
  if (!selectLongestKlines(payloads).length) {
    payloads = [
      ...payloads,
      ...await emGetAll(path).catch(() => []),
    ]
  }
  return parseSectorFlowRows(selectLongestKlines(payloads), days)
}

async function fetchSectorMembers(code) {
  const fields =
    'f12,f14,f2,f3,f4,f8,f9,f10,f20,f23,f62,f184,f6,f7'
  const path =
    `/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2`
    + `&fid=f62&fs=${encodeURIComponent(`b:${code}+f:!50`)}`
    + `&fields=${fields}`
  const payload = await emGet(path)
  return (payload?.data?.diff || []).map(mapStockRow)
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        output[index] = await mapper(items[index], index)
      }
    },
  )
  await Promise.all(workers)
  return output
}

export async function collectSectorForecastData({
  universeLimit = 24,
  fetchConceptRowsImpl = fetchConceptRows,
  fetchSectorHistoryImpl = fetchSectorHistory,
  fetchSectorMembersImpl = fetchSectorMembers,
} = {}) {
  const allSectors = await fetchConceptRowsImpl()
  const sectors = selectSectorForecastUniverse(
    allSectors,
    universeLimit,
  )
  const histories = new Map()
  const members = new Map()
  await mapLimit(sectors, 6, async (sector) => {
    const [history, memberRows] = await Promise.all([
      fetchSectorHistoryImpl(sector.code).catch(() => []),
      fetchSectorMembersImpl(sector.code).catch(() => []),
    ])
    histories.set(sector.code, history)
    members.set(sector.code, memberRows)
  })
  return {
    allSectors,
    sectors,
    histories,
    members,
  }
}
