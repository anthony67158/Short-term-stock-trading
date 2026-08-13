const NEAR_LIMIT_FACTOR = 0.95
const AT_LIMIT_TOLERANCE_PCT = 0.2

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizedSecurity(security = {}) {
  return {
    code: String(security.code || '').trim(),
    name: String(security.name || '').trim().toUpperCase(),
  }
}

export function priceLimitRatio(security = {}) {
  const { code, name } = normalizedSecurity(security)
  if (/^(30|68)/.test(code)) return 0.2
  if (/^(4|8|92)/.test(code)) return 0.3
  if (/(?:\*?ST)/i.test(name)) return 0.05
  return 0.1
}

export function priceLimitThresholdPct(security = {}, near = false) {
  const legalLimitPct = priceLimitRatio(security) * 100
  const threshold = near
    ? legalLimitPct * NEAR_LIMIT_FACTOR
    : legalLimitPct - AT_LIMIT_TOLERANCE_PCT
  return Number(threshold.toFixed(2))
}

export function formatPriceLimitThreshold(security = {}, near = false) {
  return Number(priceLimitThresholdPct(security, near).toFixed(2)).toString()
}

export function isNearPriceLimit(security = {}, side = 'up') {
  const pct = finite(security.pct)
  if (pct == null) return false
  const threshold = priceLimitThresholdPct(security, true)
  return side === 'down' ? pct <= -threshold : pct >= threshold
}

export function classifyPriceLimit(security = {}) {
  const pct = finite(security.pct)
  if (pct == null) return { isLimitUp: false, isLimitDown: false }
  const threshold = priceLimitThresholdPct(security)
  return {
    isLimitUp: pct >= threshold,
    isLimitDown: pct <= -threshold,
  }
}
