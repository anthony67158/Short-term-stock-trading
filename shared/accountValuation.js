const round2 = (value) => +Number(value || 0).toFixed(2)

function finiteOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function accountInitialCapital(account) {
  const explicit = finiteOrNull(account?.initialCapital)
  if (explicit != null && explicit >= 0) return explicit
  const legacy = finiteOrNull(account?.totalAssets)
  return legacy != null && legacy >= 0 ? legacy : null
}

export function deriveAccountValuation({
  holdMktValue = 0,
  holdCostValue = 0,
  account = null,
} = {}) {
  const marketValue = Math.max(0, finiteOrNull(holdMktValue) ?? 0)
  const costValue = Math.max(0, finiteOrNull(holdCostValue) ?? 0)
  const legacyTotal = finiteOrNull(account?.totalAssets)
  const initialCapital = accountInitialCapital(account)

  let cash = finiteOrNull(account?.cash)
  if (cash == null && legacyTotal != null) {
    cash = round2(legacyTotal - costValue)
  }

  const totalAssets = cash != null
    ? round2(cash + marketValue)
    : legacyTotal != null
      ? round2(legacyTotal)
      : round2(marketValue)
  const totalPnl = initialCapital != null
    ? round2(totalAssets - initialCapital)
    : null
  const totalPnlPct = totalPnl != null && initialCapital > 0
    ? +((totalPnl / initialCapital) * 100).toFixed(2)
    : null

  return {
    cash,
    available: cash != null ? Math.max(0, round2(cash)) : null,
    totalAssets,
    initialCapital,
    totalPnl,
    totalPnlPct,
  }
}

export function applyAccountCashFlow(account, cashFlow, now = Date.now()) {
  const cash = finiteOrNull(account?.cash)
  const flow = finiteOrNull(cashFlow)
  if (cash == null || flow == null) {
    return { account, applied: false }
  }
  return {
    account: {
      ...(account || {}),
      cash: round2(cash + flow),
      cashUpdatedAt: now,
    },
    applied: true,
  }
}
