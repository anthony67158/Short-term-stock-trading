function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 4) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function compactDate(value) {
  const text = String(value || '').replace(/\D/g, '')
  return /^\d{8}$/.test(text) ? text : null
}

export function activeSectorMembershipByCode(
  memberships = [],
  tradeDate,
) {
  const date = compactDate(tradeDate)
  if (!date) throw new Error('历史板块日期无效')
  const selected = new Map()
  for (const item of Array.isArray(memberships) ? memberships : []) {
    const code = String(item?.code || '')
    const inDate = compactDate(item?.inDate) || '19000101'
    const outDate = compactDate(item?.outDate)
    if (
      !/^\d{6}$/.test(code)
      || !item?.sectorCode
      || !item?.sectorName
      || inDate > date
      || (outDate && outDate < date)
    ) continue
    const current = selected.get(code)
    if (!current || String(current.inDate) < inDate) {
      selected.set(code, {
        code,
        sectorCode: String(item.sectorCode),
        sectorName: String(item.sectorName),
        inDate,
        outDate,
      })
    }
  }
  return selected
}

function sectorPhase({
  pct,
  breadthPct,
  mainNetYi,
}) {
  if (pct >= 1.2 && breadthPct >= 60 && mainNetYi > 0) {
    return 'ACCELERATION'
  }
  if (pct >= 0.3 && breadthPct >= 52 && mainNetYi > 0) {
    return 'STARTUP'
  }
  if (mainNetYi > 0 && pct > -0.8) return 'ACCUMULATION'
  if (pct >= 0 && (breadthPct < 50 || mainNetYi <= 0)) {
    return 'DIVERGENCE'
  }
  return 'RETREAT'
}

function actionability(phase) {
  if (['ACCUMULATION', 'STARTUP'].includes(phase)) return 'LAYOUT'
  if (phase === 'ACCELERATION') return 'WAIT_PULLBACK'
  if (phase === 'DIVERGENCE') return 'WATCH_ONLY'
  return 'AVOID'
}

export function buildHistoricalSectorOpportunities({
  quotes = [],
  funds = new Map(),
  memberships = [],
  tradeDate,
} = {}) {
  const membershipByCode = activeSectorMembershipByCode(
    memberships,
    tradeDate,
  )
  const groups = new Map()
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    const membership = membershipByCode.get(String(quote?.code || ''))
    const pct = finite(quote?.pct)
    if (!membership || pct == null) continue
    const fund = funds.get(membership.code) || {}
    const mainNetYi = finite(
      fund.mainNetYi ?? fund.main5dYi,
    )
    const group = groups.get(membership.sectorCode) || {
      code: membership.sectorCode,
      name: membership.sectorName,
      members: [],
    }
    group.members.push({
      code: membership.code,
      pct,
      mainNetYi,
    })
    groups.set(group.code, group)
  }
  const sectors = [...groups.values()].map((group) => {
    const pct = group.members.reduce(
      (sum, item) => sum + item.pct,
      0,
    ) / group.members.length
    const breadthPct = group.members.filter(
      (item) => item.pct > 0,
    ).length / group.members.length * 100
    const flowValues = group.members
      .map((item) => item.mainNetYi)
      .filter((value) => value != null)
    const mainNetYi = flowValues.reduce(
      (sum, value) => sum + value,
      0,
    )
    const flowCoverage = flowValues.length / group.members.length
    const score = (
      pct * 10
      + (breadthPct - 50) * 0.2
      + clamp(
        mainNetYi / Math.max(1, group.members.length),
        -1,
        1,
      ) * 10
    )
    const phase = sectorPhase({ pct, breadthPct, mainNetYi })
    return {
      ...group,
      pct,
      breadthPct,
      mainNetYi,
      flowCoverage,
      score,
      phase,
      actionability: actionability(phase),
    }
  }).sort((left, right) =>
    right.score - left.score
    || right.mainNetYi - left.mainNetYi
    || left.code.localeCompare(right.code)
  )
  const byCode = new Map()
  sectors.forEach((sector, index) => {
    const rank = index + 1
    for (const member of sector.members) {
      byCode.set(member.code, {
        matched: true,
        probeEligible: (
          sector.actionability === 'LAYOUT'
          && sector.flowCoverage >= 0.6
        ),
        entryMode: sector.actionability === 'LAYOUT'
          ? 'MANUAL_PROBE'
          : sector.actionability === 'WAIT_PULLBACK'
            ? 'WAIT_PULLBACK'
            : 'NONE',
        sector: {
          code: sector.code,
          name: sector.name,
          rank,
          flowRank: rank,
          phase: sector.phase,
          actionability: sector.actionability,
          pct: rounded(sector.pct),
          mainNetYi: rounded(sector.mainNetYi, 6),
          breadthPct: rounded(sector.breadthPct, 2),
          memberCount: sector.members.length,
          flowCoverage: rounded(sector.flowCoverage, 4),
        },
        stock: {
          code: member.code,
          role: 'member',
          roleLabel: '行业成员',
          score: rounded(clamp(100 - index * 3, 0, 100), 1),
          pct: rounded(member.pct),
          mainInflow: rounded(member.mainNetYi, 6),
        },
      })
    }
  })
  return byCode
}
