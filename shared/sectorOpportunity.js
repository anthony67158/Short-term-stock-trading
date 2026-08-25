export const SECTOR_OPPORTUNITY_SCHEMA_VERSION =
  'sector-opportunity.v1'

const ACTION_PRIORITY = Object.freeze({
  LAYOUT: 4,
  WAIT_PULLBACK: 3,
  WATCH_ONLY: 2,
  AVOID: 1,
})

const PROBE_ROLES = new Set(['leader', 'core', 'elastic'])
const MAX_SIGNAL_AGE_MS = 72 * 60 * 60 * 1000

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function text(value, maximum = 120) {
  return String(value || '').trim().slice(0, maximum)
}

function snapshots(latest, intraday, now) {
  return [latest, intraday]
    .filter((item) =>
      item
      && Array.isArray(item.sectors)
      && item.sectors.length > 0
      && finite(item.generatedAt) != null
      && finite(item.generatedAt) <= now
      && now - finite(item.generatedAt) <= MAX_SIGNAL_AGE_MS
    )
    .sort((left, right) =>
      Number(right.generatedAt || 0)
      - Number(left.generatedAt || 0)
    )
}

function stockMatches(snapshot, code) {
  const matches = []
  for (const sector of snapshot.sectors || []) {
    const stock = (sector.stocks || []).find(
      (item) => String(item?.code || '') === code,
    )
    if (!stock) continue
    matches.push({ sector, stock })
  }
  return matches.sort((left, right) =>
    (ACTION_PRIORITY[right.sector.actionability] || 0)
      - (ACTION_PRIORITY[left.sector.actionability] || 0)
    || Number(left.sector.rank || 999)
      - Number(right.sector.rank || 999)
    || Number(right.stock.score || 0)
      - Number(left.stock.score || 0)
  )
}

export function buildSectorOpportunity({
  code,
  latest = null,
  intraday = null,
  now = Date.now(),
} = {}) {
  const normalizedCode = text(code, 12)
  if (!/^\d{6}$/.test(normalizedCode)) {
    return {
      schemaVersion: SECTOR_OPPORTUNITY_SCHEMA_VERSION,
      matched: false,
      probeEligible: false,
      entryMode: 'NONE',
    }
  }

  const currentSnapshot = snapshots(latest, intraday, now)[0]
  const match = currentSnapshot
    ? stockMatches(currentSnapshot, normalizedCode)[0]
    : null
  if (match) {
    const { sector, stock } = match
    const actionability = text(sector.actionability, 30)
    const role = text(stock.role, 30)
    const probeEligible = actionability === 'LAYOUT'
      && PROBE_ROLES.has(role)
      && (finite(stock.score) || 0) >= 65
      && (finite(stock.mainInflow) || 0) > 0
    return {
      schemaVersion: SECTOR_OPPORTUNITY_SCHEMA_VERSION,
      matched: true,
      probeEligible,
      entryMode: probeEligible
        ? 'MANUAL_PROBE'
        : actionability === 'WAIT_PULLBACK'
          ? 'WAIT_PULLBACK'
          : 'NONE',
      signalDate: text(currentSnapshot.signalDate, 16),
      generatedAt: finite(currentSnapshot.generatedAt),
      sourceSession:
        text(currentSnapshot.session, 20) || 'close',
      sector: {
        code: text(sector.code, 16),
        name: text(sector.name, 60),
        rank: finite(sector.rank),
        phase: text(sector.phase, 30),
        actionability,
        nextScore: finite(sector.forecast?.next?.score),
        weekScore: finite(sector.forecast?.week?.score),
        breadth: finite(sector.breadth?.inflowPct),
        reasons: (sector.reasons || [])
          .map((item) => text(item, 120))
          .filter(Boolean)
          .slice(0, 4),
        risks: (sector.risks || [])
          .map((item) => text(item, 120))
          .filter(Boolean)
          .slice(0, 4),
      },
      stock: {
        code: normalizedCode,
        name: text(stock.name, 40),
        role,
        roleLabel: text(stock.roleLabel, 30),
        score: finite(stock.score),
        pct: finite(stock.pct),
        mainInflow: finite(stock.mainInflow),
      },
    }
  }

  return {
    schemaVersion: SECTOR_OPPORTUNITY_SCHEMA_VERSION,
    matched: false,
    probeEligible: false,
    entryMode: 'NONE',
  }
}
