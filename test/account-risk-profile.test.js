import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNT_RISK_PROFILE_VERSION,
  resolveAccountRiskProfile,
} from '../shared/accountRiskProfiles.js'

test('BASELINE复现批准的默认风险合同', () => {
  const profile = resolveAccountRiskProfile()

  assert.equal(profile.schemaVersion, ACCOUNT_RISK_PROFILE_VERSION)
  assert.equal(profile.id, 'BASELINE')
  assert.equal(profile.singleTradeRiskPct, 0.6)
  assert.equal(profile.maximumOpenRiskPct, 5)
  assert.equal(profile.maximumSinglePositionPct, 20)
  assert.equal(profile.maximumPositionPct, 85)
  assert.equal(profile.minimumCashReservePct, 10)
  assert.equal(profile.leverage, 1)
})

test('ELEVATED_RESEARCH必须由已通过基线的研究运行显式选择', () => {
  assert.throws(
    () => resolveAccountRiskProfile('ELEVATED_RESEARCH'),
    /不能自动进入生产配置/,
  )
  assert.throws(
    () => resolveAccountRiskProfile('ELEVATED_RESEARCH', {
      purpose: 'RESEARCH',
    }),
    /基线未通过/,
  )

  const profile = resolveAccountRiskProfile('ELEVATED_RESEARCH', {
    purpose: 'RESEARCH',
    baselineQualified: true,
  })
  assert.equal(profile.singleTradeRiskPct, 0.8)
  assert.equal(profile.maximumOpenRiskPct, 6)
  assert.equal(profile.maximumSinglePositionPct, 25)
  assert.equal(profile.maximumPositionPct, 90)
  assert.equal(profile.minimumCashReservePct, 5)
})

test('ABSOLUTE_CAP不能由生产运行自动选择', () => {
  assert.throws(
    () => resolveAccountRiskProfile('ABSOLUTE_CAP', {
      purpose: 'PRODUCTION',
      baselineQualified: true,
    }),
    /不能自动进入生产配置/,
  )

  const researchCap = resolveAccountRiskProfile('ABSOLUTE_CAP', {
    purpose: 'RESEARCH',
    baselineQualified: true,
  })
  assert.equal(researchCap.singleTradeRiskPct, 1)
  assert.equal(researchCap.maximumPositionPct, 95)
  assert.equal(researchCap.leverage, 1)
})
