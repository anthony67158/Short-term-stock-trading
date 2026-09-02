import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFormulaEvidenceReference,
} from '../shared/formulaEvidencePolicy.js'

function decision(overrides = {}) {
  return {
    schemaVersion: 'formula-price-decision.v1',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    positionMode: 'UNOWNED',
    action: 'WATCH_BUY',
    primaryPrice: 10,
    stopPrice: 9.5,
    targetPrice: 10.9,
    riskReward: 1.8,
    dataComplete: true,
    dataFresh: true,
    priceContractValid: true,
    marketAllowsRisk: true,
    ...overrides,
  }
}

test('未验证公式只以5%次级价位证据进入军师', () => {
  const result = buildFormulaEvidenceReference(decision(), {
    validationState: 'OBSERVE_ONLY',
    sampleSize: 0,
  })

  assert.equal(result.schemaVersion, 'formula-evidence.v1')
  assert.equal(result.effectiveWeight, 0.05)
  assert.equal(result.role, 'SECONDARY_PRICE_REFERENCE')
  assert.equal(result.canUpgradeAction, false)
  assert.equal(result.canForceRiskReduction, false)
})

test('公式只有样本外稳定后才能升权且最高15%', () => {
  const backtestPositive = buildFormulaEvidenceReference(decision(), {
    validationState: 'BACKTEST_POSITIVE',
    sampleSize: 40,
    expectancyPct: 0.2,
    profitFactor: 1.1,
  })
  assert.equal(backtestPositive.effectiveWeight, 0.1)

  const validated = buildFormulaEvidenceReference(decision(), {
    validationState: 'VALIDATED',
    sampleSize: 120,
    expectancyPct: 0.3,
    profitFactor: 1.2,
    stableWindows: 2,
  })
  assert.equal(validated.effectiveWeight, 0.15)
})

test('数据过期价格非法或新增风险被阻断时权重归零', () => {
  for (const input of [
    decision({ dataFresh: false }),
    decision({ priceContractValid: false }),
    decision({ riskReward: 1.79 }),
    decision({ marketAllowsRisk: false }),
  ]) {
    const result = buildFormulaEvidenceReference(input, {
      validationState: 'VALIDATED',
      sampleSize: 120,
      expectancyPct: 0.3,
      profitFactor: 1.2,
      stableWindows: 2,
    })
    assert.equal(result.effectiveWeight, 0)
    assert.ok(result.conflicts.length > 0)
  }
})

test('大盘阻断后保留的研究价格不能升级为买入证据', () => {
  const result = buildFormulaEvidenceReference(decision({
    action: 'AVOID',
    marketAllowsRisk: false,
    executionState: 'MARKET_BLOCKED',
    blockers: ['当前市场环境不支持新增风险'],
  }), {
    validationState: 'VALIDATED',
    sampleSize: 120,
    expectancyPct: 0.3,
    profitFactor: 1.2,
    stableWindows: 2,
  })

  assert.equal(result.effectiveWeight, 0)
  assert.equal(result.canUpgradeAction, false)
  assert.match(result.conflicts.join('；'), /不允许新增风险/)
})

test('持仓硬止损作为确定性风险退出而不是普通低权重参考', () => {
  const result = buildFormulaEvidenceReference(decision({
    positionMode: 'HELD',
    action: 'EXIT',
    hardStopTriggered: true,
    marketAllowsRisk: false,
  }), {
    validationState: 'OBSERVE_ONLY',
  })

  assert.equal(result.effectiveWeight, 1)
  assert.equal(result.role, 'DETERMINISTIC_RISK_OVERRIDE')
  assert.equal(result.canUpgradeAction, false)
  assert.equal(result.canForceRiskReduction, true)
})
