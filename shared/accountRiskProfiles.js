export const ACCOUNT_RISK_PROFILE_VERSION = 'account-risk-profiles.v1'

export const ACCOUNT_RISK_PROFILES = Object.freeze({
  BASELINE: Object.freeze({
    id: 'BASELINE',
    singleTradeRiskPct: 0.6,
    maximumOpenRiskPct: 5,
    maximumSinglePositionPct: 20,
    maximumPositionPct: 85,
    minimumCashReservePct: 10,
  }),
  ELEVATED_RESEARCH: Object.freeze({
    id: 'ELEVATED_RESEARCH',
    singleTradeRiskPct: 0.8,
    maximumOpenRiskPct: 6,
    maximumSinglePositionPct: 25,
    maximumPositionPct: 90,
    minimumCashReservePct: 5,
  }),
  ABSOLUTE_CAP: Object.freeze({
    id: 'ABSOLUTE_CAP',
    singleTradeRiskPct: 1,
    maximumOpenRiskPct: 7,
    maximumSinglePositionPct: 30,
    maximumPositionPct: 95,
    minimumCashReservePct: 5,
  }),
})

export function resolveAccountRiskProfile(
  profileId = 'BASELINE',
  {
    purpose = 'PRODUCTION',
    baselineQualified = false,
  } = {},
) {
  const id = String(profileId || 'BASELINE').toUpperCase()
  const profile = ACCOUNT_RISK_PROFILES[id]
  if (!profile) throw new Error('未知账户风险档')
  const normalizedPurpose = String(purpose || '').toUpperCase()
  if (id !== 'BASELINE' && normalizedPurpose !== 'RESEARCH') {
    throw new Error(`${id}不能自动进入生产配置`)
  }
  if (id !== 'BASELINE' && baselineQualified !== true) {
    throw new Error('基线未通过，不得评估更高风险档')
  }
  return Object.freeze({
    schemaVersion: ACCOUNT_RISK_PROFILE_VERSION,
    ...profile,
    purpose: normalizedPurpose,
    leverage: 1,
  })
}
