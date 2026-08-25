import test from 'node:test'
import assert from 'node:assert/strict'

import {
  recordStrategyHumanApproval,
  strategyGovernanceSnapshot,
} from '../api/strategy_governance.js'
import {
  CURRENT_STRATEGY_EVALUATION,
} from '../shared/strategyPromotionGate.js'
import { getStrategySpecV2 } from '../shared/strategyCatalogV2.js'

function eligibleData() {
  return {
    realOutcomeLearning: {
      overall: {
        samples: 40,
        posteriorWinRate: 58,
        profitFactor: 1.4,
        expectancy: 80,
      },
    },
    advisorCouncilShadow: Array.from({ length: 24 }, (_, index) => ({
      schemaVersion: 'advisor-council-shadow.v1',
      shadowOnly: true,
      actionable: false,
      code: '600001',
      at: index,
      compiled: {
        consensusReached: true,
        hardGatePassed: index < 21,
      },
    })),
  }
}

function passingEvaluation() {
  return {
    ...CURRENT_STRATEGY_EVALUATION,
    decision: 'promote',
    folds: 6,
    positiveFolds: 5,
    maximumDrawdown: -0.08,
    benchmarks: {
      CSI300: { positiveExcessFolds: 5, compoundedExcessReturn: 0.06 },
      CSI1000: { positiveExcessFolds: 5, compoundedExcessReturn: 0.05 },
    },
  }
}

test('治理快照公开拒绝原因但不返回委员会完整提示上下文', () => {
  const snapshot = strategyGovernanceSnapshot({
    realOutcomeLearning: { overall: { samples: 0 } },
    advisorCouncilShadow: [{
      schemaVersion: 'advisor-council-shadow.v1',
      shadowOnly: true,
      actionable: false,
      code: '600001',
      at: 10,
      opinions: [{ thesis: '内部详细推理' }],
      compiled: {
        consensusReached: false,
        hardGatePassed: false,
        blockers: ['策略尚未通过生产晋级门禁'],
      },
    }],
  })

  assert.equal(snapshot.schemaVersion, 'strategy-governance.v2')
  assert.equal(snapshot.strategies.length, 5)
  assert.equal(snapshot.productionStrategies.length, 0)
  assert.equal(snapshot.gate.productionEligible, false)
  assert.equal(snapshot.evaluation.decision, 'reject')
  assert.equal(
    snapshot.strategies.find(
      (item) => item.strategyId === 'market-quant-resonance',
    ).state,
    'rejected',
  )
  assert.equal(snapshot.council.latest.length, 1)
  assert.equal(snapshot.council.latest[0].opinions, undefined)
  assert.equal(snapshot.council.latest[0].hardGatePassed, false)
})

test('治理快照按策略汇总已验证建议作为模拟观察', () => {
  const specVersion = getStrategySpecV2('trend-breakout').specVersion
  const snapshot = strategyGovernanceSnapshot({
    adviceLog: [
      {
        id: 'trend-1',
        code: '600001',
        mode: 'buy_advice',
        action: '买入',
        strategyId: 'trend-breakout',
        specVersion,
        verified: true,
        outcomePolicyVersion: 2,
        hit: true,
        resultPct: 4,
        at: 100,
      },
      {
        id: 'trend-2',
        code: '600002',
        mode: 'buy_advice',
        action: '买入',
        strategyId: 'trend-breakout',
        specVersion,
        verified: false,
        at: 200,
      },
    ],
  })
  const trend = snapshot.strategies.find(
    (item) => item.strategyId === 'trend-breakout',
  )

  assert.equal(trend.shadow.samples, 1)
  assert.equal(trend.shadow.pending, 1)
  assert.equal(trend.shadow.netReturn, 0.04)
})

test('当前离线REJECT不能被人工批准密钥强行覆盖', () => {
  const data = eligibleData()

  const result = recordStrategyHumanApproval(data, {
    suppliedKey: 'independent-approval-key',
    configuredKey: 'independent-approval-key',
    approvedBy: 'owner',
    now: 123,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'GATE_BLOCKED')
  assert.equal(data.strategyHumanApproval, undefined)
})

test('独立密钥正确且其他门禁全过时才记录同版本人工批准', () => {
  const data = eligibleData()
  const evaluation = passingEvaluation()

  const denied = recordStrategyHumanApproval(data, {
    evaluation,
    suppliedKey: 'wrong-approval-key',
    configuredKey: 'independent-approval-key',
    approvedBy: 'owner',
    now: 123,
  })
  const approved = recordStrategyHumanApproval(data, {
    evaluation,
    suppliedKey: 'independent-approval-key',
    configuredKey: 'independent-approval-key',
    approvedBy: 'owner',
    now: 123,
  })

  assert.equal(denied.code, 'APPROVAL_UNAUTHORIZED')
  assert.equal(approved.ok, true)
  assert.equal(approved.gate.productionEligible, true)
  assert.deepEqual(data.strategyHumanApproval, {
    specVersion: evaluation.specVersion,
    approvedAt: 123,
    approvedBy: 'owner',
  })
})
