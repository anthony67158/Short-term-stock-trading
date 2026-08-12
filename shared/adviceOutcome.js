export const ADVICE_OUTCOME_POLICY_VERSION = 2

export const ADVICE_ACTION_LABELS = {
  bull: '买入/加仓',
  hold: '继续持有',
  bear: '减仓/清仓',
  wait: '观望/等待',
  other: '其他',
}

export function adviceActionKind(action) {
  const text = String(action || '')
  const hold = /持有|持股|继续持|按兵不动|拿住|捂|不动/.test(text)
    && !/加|减|清/.test(text)
  if (hold) return 'hold'
  if (/买|加|正T|立即|回调再买|抄底|吸|上车|建仓|补仓/.test(text)) {
    return 'bull'
  }
  if (/减|清|反T|止损|离场/.test(text)) return 'bear'
  if (/观望|不建议|回避|谨慎|等待/.test(text)) return 'wait'
  return 'other'
}

export function isAdviceOutcomeCurrent(record) {
  return !!record
    && record.verified === true
    && record.hit != null
    && Number(record.outcomePolicyVersion) === ADVICE_OUTCOME_POLICY_VERSION
}

export function adviceNeedsVerification(record) {
  return !isAdviceOutcomeCurrent(record)
}

export function adviceCandleLimit(records, code, now = Date.now()) {
  const times = (Array.isArray(records) ? records : [])
    .filter((record) =>
      record?.code === code
      && adviceNeedsVerification(record)
      && Number.isFinite(Number(record.at))
    )
    .map((record) => Number(record.at))
  if (!times.length) return 8
  const oldest = Math.min(...times)
  const ageDays = Math.max(0, (Number(now) - oldest) / 86400000)
  return Math.max(8, Math.min(500, Math.ceil(ageDays * 5 / 7) + 10))
}

function summarizeGroups(records, keyOf, nameKey) {
  const grouped = {}
  for (const record of records) {
    const key = keyOf(record)
    if (!grouped[key]) {
      grouped[key] = {
        [nameKey]: key,
        total: 0,
        hit: 0,
        sumPct: 0,
      }
    }
    grouped[key].total++
    if (record.hit) grouped[key].hit++
    grouped[key].sumPct += Number(record.resultPct) || 0
  }
  return Object.values(grouped).map((group) => ({
    ...group,
    winRate: group.total
      ? Math.round((group.hit / group.total) * 100)
      : null,
    avgPct: group.total
      ? +(group.sumPct / group.total).toFixed(2)
      : null,
  }))
}

export function summarizeAdviceOutcomes(records) {
  const source = Array.isArray(records) ? records : []
  const log = source.filter(isAdviceOutcomeCurrent)
  const groups = summarizeGroups(
    log,
    (record) => record.mode || 'other',
    'mode',
  )
  const actions = summarizeGroups(
    log,
    (record) => adviceActionKind(record.action),
    'kind',
  ).map((group) => ({
    ...group,
    label: ADVICE_ACTION_LABELS[group.kind] || group.kind,
    reliable: group.total >= 8,
  }))
  const total = log.length
  const hit = log.filter((record) => record.hit).length
  const sumPct = log.reduce(
    (sum, record) => sum + (Number(record.resultPct) || 0),
    0,
  )
  const bands = [
    { key: 'high', label: '较可信(≥68)', min: 68, max: Infinity },
    { key: 'mid', label: '中等(48~68)', min: 48, max: 68 },
    { key: 'low', label: '低(<48)', min: -Infinity, max: 48 },
  ]
  const byTrust = bands.map((band) => {
    const items = log.filter((record) => {
      const trust = Number(record.trust)
      return Number.isFinite(trust)
        && trust >= band.min
        && trust < band.max
    })
    const bandHits = items.filter((record) => record.hit).length
    const bandPct = items.reduce(
      (sum, record) => sum + (Number(record.resultPct) || 0),
      0,
    )
    return {
      band: band.key,
      label: band.label,
      total: items.length,
      hit: bandHits,
      winRate: items.length
        ? Math.round((bandHits / items.length) * 100)
        : null,
      avgPct: items.length
        ? +(bandPct / items.length).toFixed(2)
        : null,
    }
  })

  return {
    groups,
    actions,
    byTrust,
    noTrust: log.filter(
      (record) => !Number.isFinite(Number(record.trust)),
    ).length,
    total,
    hit,
    winRate: total ? Math.round((hit / total) * 100) : null,
    avgPct: total ? +(sumPct / total).toFixed(2) : null,
    pending: source.filter(adviceNeedsVerification).length,
  }
}
