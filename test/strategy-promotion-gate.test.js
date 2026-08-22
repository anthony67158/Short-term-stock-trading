import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CURRENT_STRATEGY_EVALUATION,
  buildStrategyPromotionGate,
} from '../shared/strategyPromotionGate.js'

function passingEvaluation() {
  return {
    ...CURRENT_STRATEGY_EVALUATION,
    decision: 'promote',
    folds: 6,
    positiveFolds: 5,
    worstFoldReturn: -0.06,
    maximumDrawdown: -0.09,
    benchmarks: {
      CSI300: { positiveExcessFolds: 5, compoundedExcessReturn: 0.08 },
      CSI1000: { positiveExcessFolds: 5, compoundedExcessReturn: 0.06 },
    },
  }
}

function liveLearning(samples = 40) {
  return {
    overall: {
      samples,
      sampleQualified: true,
      posteriorWinRate: 58,
      profitFactor: 1.35,
      expectancy: 75,
    },
  }
}

function councilRecords(count = 24) {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 'advisor-council-shadow.v1',
    compiled: {
      consensusReached: true,
      hardGatePassed: index < 21,
    },
  }))
}

test('当前嵌套回测REJECT时生产晋级被硬阻断', () => {
  const gate = buildStrategyPromotionGate({
    evaluation: CURRENT_STRATEGY_EVALUATION,
    realOutcomeLearning: liveLearning(),
    councilRecords: councilRecords(),
    humanApproval: {
      specVersion: CURRENT_STRATEGY_EVALUATION.specVersion,
      approvedAt: 100,
      approvedBy: 'owner',
    },
  })

  assert.equal(gate.shadowEligible, true)
  assert.equal(gate.productionEligible, false)
  assert.ok(gate.blockers.some((item) => item.code === 'OFFLINE_REJECTED'))
})

test('所有量化与真实样本达标后仍必须人工批准相同策略版本', () => {
  const gate = buildStrategyPromotionGate({
    evaluation: passingEvaluation(),
    realOutcomeLearning: liveLearning(),
    councilRecords: councilRecords(),
  })

  assert.equal(gate.productionEligible, false)
  assert.ok(gate.blockers.some((item) => item.code === 'HUMAN_APPROVAL_REQUIRED'))
})

test('离线超额真实收益委员会与人工批准全部达标才允许晋级', () => {
  const evaluation = passingEvaluation()
  const gate = buildStrategyPromotionGate({
    evaluation,
    realOutcomeLearning: liveLearning(),
    councilRecords: councilRecords(),
    humanApproval: {
      specVersion: evaluation.specVersion,
      approvedAt: 100,
      approvedBy: 'owner',
    },
  })

  assert.equal(gate.productionEligible, true)
  assert.deepEqual(gate.blockers, [])
  assert.equal(gate.metrics.council.hardGatePassRate, 87.5)
})

test('旧回测版本不能为新的StrategySpec版本解锁生产', () => {
  const evaluation = passingEvaluation()
  const gate = buildStrategyPromotionGate({
    strategySpec: {
      strategyId: evaluation.strategyId,
      specVersion: 'strategy.new-version',
    },
    evaluation,
    realOutcomeLearning: liveLearning(),
    councilRecords: councilRecords(),
    humanApproval: {
      specVersion: 'strategy.new-version',
      approvedAt: 100,
      approvedBy: 'owner',
    },
  })

  assert.equal(gate.productionEligible, false)
  assert.equal(gate.specVersion, 'strategy.new-version')
  assert.equal(gate.evaluationSpecVersion, evaluation.specVersion)
  assert.ok(gate.blockers.some(
    (item) => item.code === 'SPEC_VERSION_MISMATCH',
  ))
})
