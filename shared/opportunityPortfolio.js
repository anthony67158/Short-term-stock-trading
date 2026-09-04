// 机会雷达组合层分析（P2-1）。
//
// 目标：在【完全不修改个股结论】的前提下，回答"这几个机会是不是独立的、
// 一起买会不会过度集中、加起来占用多少新增风险预算"。它消费某个 lane 已
// 排好序的 opportunity 行，输出组合视图：每个候选新增一个 portfolioState
// 与中文说明，并汇总板块暴露与总预算占用。
//
// 纯函数、无副作用、不联网、不读账户明文；输入行对象不会被 mutate。

export const OPPORTUNITY_PORTFOLIO_SCHEMA_VERSION =
  'opportunity-portfolio.v1'

// 默认约束：单只 5%（与军师小仓试错上限一致）、单板块 10%、总新增风险 15%。
const DEFAULT_MAX_PER_POSITION_PCT = 5
const DEFAULT_MAX_PER_SECTOR_PCT = 10
const DEFAULT_MAX_CORRELATED_THEME_PCT = 8
const DEFAULT_MAX_TOTAL_NEW_RISK_PCT = 15

// 只有真正可入场的状态才占用组合预算；方向观察与不买不占预算。
const ACTIONABLE_STATES = new Set(['READY', 'WAIT_TRIGGER'])

function finite(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function positionPctOf(row, maxPerPositionPct) {
  const requested = finite(row?.entryPlan?.maxPositionPct)
  if (requested == null || requested <= 0) return maxPerPositionPct
  return Math.min(requested, maxPerPositionPct)
}

function sectorKeyOf(row) {
  const code = String(row?.sector?.code || '').trim()
  const name = String(row?.sector?.name || '').trim()
  return {
    code: code || name || '',
    name: name || code || '未知板块',
  }
}

function themesOf(row) {
  return [...new Set(
    (Array.isArray(row?.tags?.concepts) ? row.tags.concepts : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )].slice(0, 6)
}

// 组合内排序键：可入场优先，其次盈亏比，再次量化分——只影响"谁先占预算"，
// 不改变原 lane 展示顺序，也不改任何 state。
function rankKey(row) {
  const actionable = ACTIONABLE_STATES.has(String(row?.state || '')) ? 1 : 0
  const ready = String(row?.state || '') === 'READY' ? 1 : 0
  return [
    actionable,
    ready,
    finite(row?.riskReward, 0),
    finite(row?.score, 0),
  ]
}

function compareRank(left, right) {
  const a = rankKey(left)
  const b = rankKey(right)
  for (let index = 0; index < a.length; index += 1) {
    if (b[index] !== a[index]) return b[index] - a[index]
  }
  return 0
}

export function analyzeOpportunityPortfolio({
  rows = [],
  holdings = [],
  maxPerPositionPct = DEFAULT_MAX_PER_POSITION_PCT,
  maxPerSectorPct = DEFAULT_MAX_PER_SECTOR_PCT,
  maxCorrelatedThemePct = DEFAULT_MAX_CORRELATED_THEME_PCT,
  maxTotalNewRiskPct = DEFAULT_MAX_TOTAL_NEW_RISK_PCT,
} = {}) {
  const positionCap = Math.max(0, finite(maxPerPositionPct, 0) || 0)
  const sectorCap = Math.max(0, finite(maxPerSectorPct, 0) || 0)
  const correlatedCap = Math.max(
    0,
    finite(maxCorrelatedThemePct, 0) || 0,
  )
  const totalCap = Math.max(0, finite(maxTotalNewRiskPct, 0) || 0)

  // 已持仓的同板块占用，作为板块上限的起点（边际集中度）。
  const heldBySector = new Map()
  for (const holding of Array.isArray(holdings) ? holdings : []) {
    const code = String(holding?.sectorCode || holding?.sector?.code || '')
      .trim()
    if (!code) continue
    const pct = Math.max(0, finite(holding?.positionPct, 0) || 0)
    heldBySector.set(code, (heldBySector.get(code) || 0) + pct)
  }

  const list = Array.isArray(rows) ? rows : []
  // 记录原始展示顺序，最终按它还原，保证组合分析不改变 lane 顺序。
  const order = new Map(list.map((row, index) => [row, index]))
  const ranked = [...list].sort(compareRank)

  const sectorApproved = new Map()
  const sectorRequested = new Map()
  const themeApproved = new Map()
  const themeRequested = new Map()
  let approvedTotal = 0
  const results = []

  for (const row of ranked) {
    const state = String(row?.state || '')
    const { code: sectorCode, name: sectorName } = sectorKeyOf(row)
    const themes = themesOf(row)
    const base = {
      ...row,
      _order: order.get(row) ?? 0,
      sectorCode,
      sectorName,
    }

    if (!ACTIONABLE_STATES.has(state)) {
      results.push({
        ...base,
        positionPct: 0,
        portfolioState: 'NOT_ACTIONABLE',
        portfolioReason: '方向参考，尚无可执行买卖计划，不占用风险预算。',
      })
      continue
    }

    const positionPct = positionPctOf(row, positionCap)
    sectorRequested.set(
      sectorCode,
      (sectorRequested.get(sectorCode) || 0) + positionPct,
    )
    for (const theme of themes) {
      themeRequested.set(
        theme,
        (themeRequested.get(theme) || 0) + positionPct,
      )
    }

    const heldPct = heldBySector.get(sectorCode) || 0
    const sectorUsed = (sectorApproved.get(sectorCode) || 0) + heldPct
    const overSector =
      sectorCap > 0 && sectorUsed + positionPct > sectorCap + 1e-9
    const overBudget =
      totalCap > 0 && approvedTotal + positionPct > totalCap + 1e-9
    const crowdedTheme = themes.find((theme) =>
      correlatedCap > 0
      && (themeApproved.get(theme) || 0) + positionPct
        > correlatedCap + 1e-9
    )

    if (overSector) {
      results.push({
        ...base,
        positionPct,
        portfolioState: 'SECTOR_CAPPED',
        portfolioReason:
          `与${sectorName}方向已选标的重叠，超过单板块暴露上限，`
          + '本轮先观察以分散同向回撤风险。',
      })
      continue
    }
    if (overBudget) {
      results.push({
        ...base,
        positionPct,
        portfolioState: 'BUDGET_CAPPED',
        portfolioReason:
          '已达到本轮新增风险预算，优先执行更靠前的机会，'
          + '其余等预算释放后再评估。',
      })
      continue
    }
    if (crowdedTheme) {
      results.push({
        ...base,
        positionPct,
        portfolioState: 'CORRELATION_CAPPED',
        portfolioReason:
          `与已纳入候选共同暴露于${crowdedTheme}主题，`
          + '相关风险超过上限，本轮只保留排序更高的机会。',
      })
      continue
    }

    sectorApproved.set(
      sectorCode,
      (sectorApproved.get(sectorCode) || 0) + positionPct,
    )
    approvedTotal += positionPct
    for (const theme of themes) {
      themeApproved.set(
        theme,
        (themeApproved.get(theme) || 0) + positionPct,
      )
    }
    results.push({
      ...base,
      positionPct,
      portfolioState: 'INCLUDED',
      portfolioReason:
        `独立机会，占用约${round(positionPct)}%仓位；`
        + '与已纳入标的分属不同方向或未超集中度上限。',
    })
  }

  // 板块暴露聚合
  const sectorCodes = new Set([
    ...sectorRequested.keys(),
    ...heldBySector.keys(),
  ])
  const sectorExposure = [...sectorCodes].map((code) => {
    const name = results.find((item) => item.sectorCode === code)
      ?.sectorName || code || '未知板块'
    return {
      sectorCode: code,
      sectorName: name,
      heldPct: round(heldBySector.get(code) || 0),
      requestedPct: round(sectorRequested.get(code) || 0),
      approvedPct: round(sectorApproved.get(code) || 0),
    }
  }).sort((a, b) =>
    (b.approvedPct || 0) - (a.approvedPct || 0)
    || (b.requestedPct || 0) - (a.requestedPct || 0),
  )

  // 还原原始展示顺序（组合分析不改变 lane 的展示排序）
  const candidates = results
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...rest }) => rest)

  const included = candidates.filter(
    (item) => item.portfolioState === 'INCLUDED',
  )
  const correlationExposure = [...themeRequested.entries()]
    .map(([theme, requestedPct]) => ({
      theme,
      requestedPct: round(requestedPct),
      approvedPct: round(themeApproved.get(theme) || 0),
    }))
    .sort((left, right) =>
      right.approvedPct - left.approvedPct
      || right.requestedPct - left.requestedPct,
    )

  return {
    schemaVersion: OPPORTUNITY_PORTFOLIO_SCHEMA_VERSION,
    limits: {
      maxPerPositionPct: round(positionCap),
      maxPerSectorPct: round(sectorCap),
      maxCorrelatedThemePct: round(correlatedCap),
      maxTotalNewRiskPct: round(totalCap),
    },
    budget: {
      limitPct: round(totalCap),
      approvedPct: round(approvedTotal),
      remainingPct: round(Math.max(0, totalCap - approvedTotal)),
      includedCount: included.length,
    },
    sectorExposure,
    correlationExposure,
    candidates,
  }
}
