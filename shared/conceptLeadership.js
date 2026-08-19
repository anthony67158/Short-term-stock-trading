import {
  isQualifiedInvestmentCandidate,
} from './investmentSelection.js'

export const CONCEPT_LEADERSHIP_SCHEMA_VERSION = 'concept-leadership.v1'

const ROLE_LABELS = Object.freeze({
  leader: '总龙头',
  core: '趋势中军',
  elastic: '弹性先锋',
  follower: '补涨跟随',
})

const finite = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const clamp = (value, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, finite(value)))

const rounded = (value, digits = 1) => +finite(value).toFixed(digits)

function percentile(value, values) {
  const usable = (Array.isArray(values) ? values : [])
    .map((item) => finite(item, NaN))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (!usable.length) return 0
  if (usable.length === 1) return 1
  let index = 0
  for (let cursor = 0; cursor < usable.length; cursor++) {
    if (usable[cursor] <= finite(value)) index = cursor
  }
  return index / (usable.length - 1)
}

function sectorEvidence(row, rows) {
  const mainInflowRank = percentile(
    row.mainInflow,
    rows.map((item) => item.mainInflow),
  )
  const mainRatioRank = percentile(
    row.mainRatio,
    rows.map((item) => item.mainRatio),
  )
  const pctRank = percentile(
    row.pct,
    rows.map((item) => item.pct),
  )
  const amountRank = percentile(
    row.amount,
    rows.map((item) => item.amount),
  )
  const leadPctRank = percentile(
    row.leadPct,
    rows.map((item) => item.leadPct),
  )
  return {
    mainInflowRank,
    mainRatioRank,
    pctRank,
    amountRank,
    leadPctRank,
  }
}

export function rankActiveConcepts(rows = [], options = {}) {
  const limit = Math.max(
    1,
    Math.min(20, Number(options.limit) || 6),
  )
  const valid = (Array.isArray(rows) ? rows : []).filter((row) =>
    /^BK\d+$/.test(String(row?.code || ''))
    && String(row?.name || '').trim()
    && finite(row?.pct) > 0
    && finite(row?.mainInflow) > 0
    && finite(row?.amount) > 0
    && /^\d{6}$/.test(String(row?.leadCode || ''))
  )
  return valid
    .map((row) => {
      const ranks = sectorEvidence(row, valid)
      const conceptStrength = (
        ranks.mainInflowRank * 30
        + ranks.mainRatioRank * 15
        + ranks.pctRank * 20
        + ranks.amountRank * 15
        + ranks.leadPctRank * 10
      )
      return {
        schemaVersion: CONCEPT_LEADERSHIP_SCHEMA_VERSION,
        code: String(row.code),
        name: String(row.name).trim(),
        pct: rounded(row.pct),
        mainInflow: rounded(row.mainInflow, 0),
        mainRatio: rounded(row.mainRatio),
        amount: rounded(row.amount, 0),
        leadCode: String(row.leadCode),
        leadName: String(row.leadName || row.leadCode).trim(),
        leadPct: rounded(row.leadPct),
        conceptStrength: rounded(conceptStrength),
        evidence: {
          mainInflowRank: rounded(ranks.mainInflowRank * 100),
          mainRatioRank: rounded(ranks.mainRatioRank * 100),
          pctRank: rounded(ranks.pctRank * 100),
          amountRank: rounded(ranks.amountRank * 100),
          leadPctRank: rounded(ranks.leadPctRank * 100),
        },
      }
    })
    .sort((left, right) =>
      right.conceptStrength - left.conceptStrength
      || right.mainInflow - left.mainInflow
      || left.code.localeCompare(right.code)
    )
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      conceptRank: index + 1,
    }))
}

function safeMember(row) {
  const code = String(row?.code || '')
  const name = String(row?.name || '')
  return /^\d{6}$/.test(code)
    && name
    && !/(?:\*?ST|退市|退$)/i.test(name)
    && finite(row?.price) > 0
    && finite(row?.amount) >= 8e7
}

function memberMetrics(row, rows, limitMap) {
  const pctRank = percentile(row.pct, rows.map((item) => item.pct))
  const inflowRank = percentile(
    row.mainInflow,
    rows.map((item) => item.mainInflow),
  )
  const ratioRank = percentile(
    row.mainRatio,
    rows.map((item) => item.mainRatio),
  )
  const amountRank = percentile(
    row.amount,
    rows.map((item) => item.amount),
  )
  const turnoverRank = percentile(
    row.turnover,
    rows.map((item) => item.turnover),
  )
  const volumeRank = percentile(
    row.volRatio,
    rows.map((item) => item.volRatio),
  )
  const amplitudeRank = percentile(
    row.amplitude,
    rows.map((item) => item.amplitude),
  )
  const event = limitMap.get(String(row.code)) || {}
  const boardHeight = Math.max(0, finite(event.lbc))
  const eventRank = clamp(
    (event.isLimitUp ? 0.5 : 0)
      + Math.min(0.5, boardHeight / 6),
    0,
    1,
  )
  const fundRank = inflowRank * 0.7 + ratioRank * 0.3
  const elasticityRank = (
    pctRank * 0.4
    + turnoverRank * 0.2
    + volumeRank * 0.2
    + amplitudeRank * 0.15
    + eventRank * 0.05
  )
  return {
    pctRank,
    inflowRank,
    ratioRank,
    fundRank,
    amountRank,
    turnoverRank,
    volumeRank,
    amplitudeRank,
    elasticityRank,
    boardHeight,
    isLimitUp: event.isLimitUp === true,
  }
}

function rolePriority(role) {
  return { leader: 0, core: 1, elastic: 2, follower: 3 }[role] ?? 4
}

export function identifyConceptLeaders(
  concept,
  members = [],
  options = {},
) {
  if (!concept?.code || !concept?.name) return []
  const rows = (Array.isArray(members) ? members : []).filter(safeMember)
  if (!rows.length) return []
  const limitMap = new Map(
    (Array.isArray(options.limitPool) ? options.limitPool : [])
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item]),
  )
  const breadthRatio = rows.filter((item) => finite(item.pct) > 0).length
    / rows.length
  const limitRatio = rows.filter((item) =>
    limitMap.get(String(item.code))?.isLimitUp === true
  ).length / rows.length
  const conceptStrength = clamp(
    finite(concept.conceptStrength)
      + breadthRatio * 7
      + limitRatio * 3,
  )
  const scored = rows.map((row) => {
    const metrics = memberMetrics(row, rows, limitMap)
    const recognizedLead = String(row.code) === String(concept.leadCode)
    const leaderScore = (
      metrics.pctRank * 20
      + metrics.fundRank * 20
      + metrics.amountRank * 15
      + (recognizedLead ? 15 : 0)
      + metrics.elasticityRank * 15
      + (conceptStrength / 100) * 15
    )
    return {
      row,
      metrics,
      recognizedLead,
      leaderScore: rounded(leaderScore),
      coreRank: metrics.amountRank * 0.6 + metrics.fundRank * 0.4,
      elasticRank: metrics.elasticityRank,
    }
  })
  const leader = scored.find((item) => item.recognizedLead)
    || scored.slice().sort((left, right) =>
      right.leaderScore - left.leaderScore
    )[0]
  const remaining = scored.filter((item) => item !== leader)
  const core = remaining.slice().sort((left, right) =>
    right.coreRank - left.coreRank
    || right.leaderScore - left.leaderScore
  )[0] || null
  const elastic = remaining
    .filter((item) => item !== core)
    .sort((left, right) =>
      right.elasticRank - left.elasticRank
      || right.leaderScore - left.leaderScore
    )[0] || null

  return scored
    .map((item) => {
      const role = item === leader
        ? 'leader'
        : item === core
          ? 'core'
          : item === elastic ? 'elastic' : 'follower'
      return {
        ...item.row,
        conceptLeadership: {
          schemaVersion: CONCEPT_LEADERSHIP_SCHEMA_VERSION,
          conceptCode: String(concept.code),
          conceptName: String(concept.name),
          conceptRank: finite(concept.conceptRank),
          conceptStrength: rounded(conceptStrength),
          role,
          roleLabel: ROLE_LABELS[role],
          leaderScore: item.leaderScore,
          memberVerified: true,
          evidence: {
            relativePctRank: rounded(item.metrics.pctRank * 100),
            mainInflowRank: rounded(item.metrics.inflowRank * 100),
            mainRatioRank: rounded(item.metrics.ratioRank * 100),
            amountRank: rounded(item.metrics.amountRank * 100),
            turnoverRank: rounded(item.metrics.turnoverRank * 100),
            volumeRank: rounded(item.metrics.volumeRank * 100),
            amplitudeRank: rounded(item.metrics.amplitudeRank * 100),
            boardHeight: item.metrics.boardHeight,
            isLimitUp: item.metrics.isLimitUp,
            recognizedLead: item.recognizedLead,
            breadthPct: rounded(breadthRatio * 100),
          },
        },
      }
    })
    .sort((left, right) =>
      rolePriority(left.conceptLeadership.role)
      - rolePriority(right.conceptLeadership.role)
      || right.conceptLeadership.leaderScore
      - left.conceptLeadership.leaderScore
      || String(left.code).localeCompare(String(right.code))
    )
}

export function isQualifiedConceptLeader(item) {
  const leadership = item?.conceptLeadership
  return leadership?.schemaVersion === CONCEPT_LEADERSHIP_SCHEMA_VERSION
    && leadership.memberVerified === true
    && finite(leadership.conceptStrength) >= 65
    && finite(leadership.leaderScore) >= 70
    && ['leader', 'core', 'elastic'].includes(leadership.role)
}

export function buildConceptLeaderCandidates(
  concepts = [],
  membersByConcept = new Map(),
  options = {},
) {
  const perConcept = Math.max(
    1,
    Math.min(3, Number(options.perConcept) || 2),
  )
  const limit = Math.max(
    1,
    Math.min(20, Number(options.limit) || 12),
  )
  const output = []
  const byCode = new Map()
  for (const concept of Array.isArray(concepts) ? concepts : []) {
    const members = membersByConcept instanceof Map
      ? membersByConcept.get(String(concept.code))
      : membersByConcept?.[concept.code]
    const leaders = identifyConceptLeaders(
      concept,
      members,
      options,
    )
      .filter(isQualifiedConceptLeader)
      .slice(0, perConcept)
    for (const item of leaders) {
      const candidate = {
        ...item,
        tags: [
          `${item.conceptLeadership.conceptName}`
            + `·${item.conceptLeadership.roleLabel}`,
        ],
      }
      const current = byCode.get(String(item.code))
      if (
        current
        && (
          finite(current.conceptLeadership?.conceptStrength)
          > finite(candidate.conceptLeadership?.conceptStrength)
          || (
            finite(current.conceptLeadership?.conceptStrength)
            === finite(candidate.conceptLeadership?.conceptStrength)
            && finite(current.conceptLeadership?.leaderScore)
            >= finite(candidate.conceptLeadership?.leaderScore)
          )
        )
      ) continue
      byCode.set(String(item.code), candidate)
    }
  }
  for (const concept of Array.isArray(concepts) ? concepts : []) {
    const candidates = [...byCode.values()]
      .filter((item) =>
        item.conceptLeadership?.conceptCode === String(concept.code)
      )
      .sort((left, right) =>
        rolePriority(left.conceptLeadership.role)
        - rolePriority(right.conceptLeadership.role)
      )
    for (const candidate of candidates) {
      if (!output.some((item) => item.code === candidate.code)) {
        output.push(candidate)
      }
      if (output.length >= limit) return output
    }
  }
  return output
}

function mergeCandidate(current, incoming) {
  if (!current) return {
    ...incoming,
    tags: [...new Set(incoming?.tags || [])],
  }
  const currentLeadership = current.conceptLeadership
  const incomingLeadership = incoming.conceptLeadership
  const useIncomingLeadership = incomingLeadership
    && (
      !currentLeadership
      || finite(incomingLeadership.conceptStrength)
        > finite(currentLeadership.conceptStrength)
      || (
        finite(incomingLeadership.conceptStrength)
          === finite(currentLeadership.conceptStrength)
        && finite(incomingLeadership.leaderScore)
          > finite(currentLeadership.leaderScore)
      )
    )
  return {
    ...incoming,
    ...current,
    conceptLeadership: useIncomingLeadership
      ? incomingLeadership
      : currentLeadership,
    investmentProfile:
      current.investmentProfile || incoming.investmentProfile || null,
    tags: [...new Set([
      ...(current.tags || []),
      ...(incoming.tags || []),
    ])],
  }
}

export function selectConceptAwareCandidatePool({
  marketCandidates = [],
  conceptCandidates = [],
  investmentCandidates = [],
  eventCandidates = [],
  limit = 20,
  marketQuota = 10,
  conceptQuota = 6,
  investmentQuota = 6,
  eventQuota = 4,
} = {}) {
  const maximum = Math.max(1, Math.min(50, Number(limit) || 20))
  const output = []
  const byCode = new Map()
  const add = (item) => {
    const code = String(item?.code || '')
    if (!/^\d{6}$/.test(code)) return
    const merged = mergeCandidate(byCode.get(code), item)
    byCode.set(code, merged)
    const index = output.findIndex((value) => String(value.code) === code)
    if (index >= 0) output[index] = merged
    else if (output.length < maximum) output.push(merged)
  }
  const take = (items, quota) => {
    let added = 0
    for (const item of Array.isArray(items) ? items : []) {
      const before = output.length
      add(item)
      if (output.length > before) added++
      if (added >= Math.max(0, Number(quota) || 0)) break
    }
  }
  take(marketCandidates, marketQuota)
  take(
    (Array.isArray(conceptCandidates) ? conceptCandidates : [])
      .filter(isQualifiedConceptLeader),
    conceptQuota,
  )
  take(
    (Array.isArray(investmentCandidates) ? investmentCandidates : [])
      .filter(isQualifiedInvestmentCandidate),
    investmentQuota,
  )
  take(eventCandidates, eventQuota)
  for (const item of [
    ...marketCandidates,
    ...investmentCandidates,
    ...conceptCandidates,
    ...eventCandidates,
  ]) {
    if (output.length >= maximum) break
    add(item)
  }
  return output.slice(0, maximum)
}
