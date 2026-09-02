const NEAR_LIMIT_FACTOR = 0.95
const AT_LIMIT_TOLERANCE_PCT = 0.2
const CHINEXT_REFORM_DATE = '20200824'
const RISK_WARNING_REFORM_DATE = '20260706'

export const ASHARE_TRADING_RULE_SCHEMA_VERSION =
  'ashare-trading-rule.v1'

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

function normalizedDate(value) {
  const compact = String(value || '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function boardOf(code) {
  if (/^68/.test(code)) return 'STAR'
  if (/^30/.test(code)) return 'CHINEXT'
  if (/^(4|8|92)/.test(code)) return 'BSE'
  return 'MAIN'
}

export function resolveAshareTradingRule(
  security = {},
  tradeDate = null,
) {
  const { code, name } = normalizedSecurity(security)
  const date = normalizedDate(tradeDate ?? security.tradeDate)
  const effectiveDate = date || RISK_WARNING_REFORM_DATE
  const board = boardOf(code)
  const riskWarning = /(?:\*?ST)/i.test(name)
  let ratio = 0.1
  if (board === 'STAR') ratio = 0.2
  else if (board === 'CHINEXT') {
    ratio = effectiveDate >= CHINEXT_REFORM_DATE
      ? 0.2
      : riskWarning ? 0.05 : 0.1
  } else if (board === 'BSE') ratio = 0.3
  else if (riskWarning && effectiveDate < RISK_WARNING_REFORM_DATE) {
    ratio = 0.05
  }
  return {
    schemaVersion: ASHARE_TRADING_RULE_SCHEMA_VERSION,
    ruleVersion: effectiveDate >= RISK_WARNING_REFORM_DATE
      ? 'CN_A_SHARE_2026_07_06'
      : effectiveDate >= CHINEXT_REFORM_DATE
        ? 'CN_A_SHARE_2020_08_24'
        : 'CN_A_SHARE_LEGACY',
    tradeDate: date,
    board,
    riskWarning,
    priceLimitRatio: ratio,
    priceTick: 0.01,
    tPlusOne: true,
  }
}

export function priceLimitRatio(security = {}, tradeDate = null) {
  return resolveAshareTradingRule(
    security,
    tradeDate,
  ).priceLimitRatio
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
