const MODES = new Set(['buy_advice', 'hold_advice'])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function inferAdviceEntryMode(entry = {}) {
  const explicit = String(entry.mode || entry.adviceMode || '')
  if (MODES.has(explicit)) return explicit

  const advice = entry.advice && typeof entry.advice === 'object'
    ? entry.advice
    : entry
  const action = String(advice.action || advice.stance || '')
  if (
    advice.pnlNote != null
    || advice.addPrice != null
    || advice.reducePrice != null
    || advice.opQty != null
  ) return 'hold_advice'
  if (
    advice.tier != null
    || advice.buyPrice != null
    || advice.buyZone != null
    || advice.watchPrice != null
    || advice.planQty != null
  ) return 'buy_advice'
  if (/^(加仓|减仓|持有|清仓)$/.test(action)) return 'hold_advice'
  if (/^(立即买入|回调再买|小仓试错|观望)$/.test(action)) return 'buy_advice'
  return null
}

export function adviceEntryMatchesMode(entry, expectedMode) {
  if (!entry || !MODES.has(expectedMode)) return !!entry
  const actual = inferAdviceEntryMode(entry)
  return actual == null || actual === expectedMode
}

export function buildAdviceDecisionContext(mode, payload = {}) {
  if (!MODES.has(mode)) return null
  const account = payload.account && typeof payload.account === 'object'
    ? payload.account
    : {}
  const values = {
    mode,
    ...(mode === 'hold_advice' ? {
      holdCost: finite(payload.holdCost),
      holdQty: finite(payload.holdQty),
      sellableTodayQty: finite(payload.sellableTodayQty),
    } : {}),
    cash: finite(account.cash),
    totalAssets: finite(account.totalAssets),
    position: finite(account.position),
    stockWeight: finite(account.stockWeight),
  }
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value != null),
  )
}
