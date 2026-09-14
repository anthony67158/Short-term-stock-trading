import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDecisionAccount,
  markDecisionAccount,
  processDecisionBar,
  submitDecisionOrder,
} from '../backtest/decision/accountEngine.mjs'
import {
  evaluateProfitabilityExperiment,
  PROFITABILITY_EXPERIMENT_VERSION,
} from '../backtest/decision/run-profitability-v2.mjs'
import {
  ACCOUNT_RISK_PROFILE_VERSION,
} from '../shared/accountRiskProfiles.js'

function completedAccount({
  quantityShares = 100,
  sellPrice = 11,
  slippageBps = 5,
  stopExecution = 'INTRADAY_STOP',
} = {}) {
  let state = createDecisionAccount({
    policy: { slippageBps, stopExecution },
  })
  state = submitDecisionOrder(state, {
    orderId: 'buy',
    code: '600001',
    security: { code: '600001', name: '样本' },
    side: 'BUY',
    submittedDate: '20260901',
    quantityShares,
    referencePrice: 10,
  })
  state = processDecisionBar(state, {
    date: '20260901',
    code: '600001',
    previousClose: 10,
    open: 10,
    low: 9.8,
    close: 10,
    volume: 100000,
  })
  state = markDecisionAccount(state, {
    date: '20260901',
    prices: { 600001: 10 },
  })
  state = submitDecisionOrder(state, {
    orderId: 'sell',
    code: '600001',
    security: { code: '600001', name: '样本' },
    side: 'SELL',
    submittedDate: '20260902',
    quantityShares,
    referencePrice: sellPrice,
  })
  state = processDecisionBar(state, {
    date: '20260902',
    code: '600001',
    previousClose: 10,
    open: sellPrice,
    low: sellPrice,
    close: sellPrice,
    volume: 100000,
  })
  return markDecisionAccount(state, { date: '20260902' })
}

function runSet(profile, {
  quantityShares = 100,
  sellPrice = 11,
  stressSellPrice = sellPrice,
  pairedExcessLower95Pct = 0.1,
} = {}) {
  const riskEvidence = profile === 'BASELINE'
    ? {
        maximumSingleTradeRiskPct: 0.6,
        maximumOpenRiskPct: 5,
      }
    : {
        maximumSingleTradeRiskPct: 0.8,
        maximumOpenRiskPct: 6,
      }
  return {
    modelProductionEligible: true,
    confirmationLocked: true,
    pairedExcessLower95Pct,
    primary: {
      riskProfileVersion: ACCOUNT_RISK_PROFILE_VERSION,
      riskProfile: profile,
      riskEvidence,
      accountState: completedAccount({
        quantityShares,
        sellPrice,
      }),
    },
    doubleSlippage: {
      riskProfileVersion: ACCOUNT_RISK_PROFILE_VERSION,
      riskProfile: profile,
      riskEvidence,
      accountState: completedAccount({
        quantityShares,
        sellPrice: stressSellPrice,
        slippageBps: 10,
      }),
    },
    nextOpen: {
      riskProfileVersion: ACCOUNT_RISK_PROFILE_VERSION,
      riskProfile: profile,
      riskEvidence,
      accountState: completedAccount({
        quantityShares,
        sellPrice: stressSellPrice,
        stopExecution: 'NEXT_OPEN',
      }),
    },
  }
}

function experiment(runs = {}) {
  return {
    schemaVersion: PROFITABILITY_EXPERIMENT_VERSION,
    experimentId: 'test',
    evidenceClass: 'SYNTHETIC_TEST',
    qualification: {
      minimumClosedTrades: 1,
      minimumNetPnlCents: 0,
      minimumPairedExcessLower95Pct: 0,
    },
    requiredInputs: {
      decisionEventStream: 'fixture',
      benchmarkCurve: 'fixture',
      reviewModelRelease: 'fixture',
    },
    runs,
  }
}

test('缺少V2决策事件、基线和模型发布时阻断盈利声明', () => {
  const result = evaluateProfitabilityExperiment({
    ...experiment(),
    requiredInputs: {
      decisionEventStream: null,
      benchmarkCurve: null,
      reviewModelRelease: null,
    },
    legacyEvidence: { returnPct: -0.7657 },
  })

  assert.equal(
    result.baseline.status,
    'BLOCKED_INCOMPLETE_REPLAY_EVIDENCE',
  )
  assert.deepEqual(result.baseline.blockers, [
    'DECISION_EVENT_STREAM_MISSING',
    'RISK_MATCHED_BENCHMARK_MISSING',
    'V2_REVIEW_MODEL_RELEASE_MISSING',
  ])
  assert.equal(
    result.elevated.status,
    'NOT_AUTHORIZED_BASELINE_FAILED',
  )
  assert.equal(result.productionEligible, false)
  assert.equal(result.conclusion, 'NO_PROFITABILITY_CLAIM')
})

test('基线为负时即使提供更高风险结果也不展示为有效比较', () => {
  const result = evaluateProfitabilityExperiment(experiment({
    BASELINE: runSet('BASELINE', {
      sellPrice: 9.5,
      stressSellPrice: 9.4,
      pairedExcessLower95Pct: -0.1,
    }),
    ELEVATED_RESEARCH: runSet('ELEVATED_RESEARCH', {
      quantityShares: 200,
    }),
  }))

  assert.equal(result.baseline.status, 'BASELINE_REJECTED')
  assert.ok(result.baseline.blockers.includes(
    'BASELINE_NET_PROFIT_NOT_POSITIVE',
  ))
  assert.ok(result.baseline.blockers.includes(
    'PAIRED_EXCESS_LOWER_BOUND_NOT_POSITIVE',
  ))
  assert.equal(
    result.elevated.status,
    'NOT_AUTHORIZED_BASELINE_FAILED',
  )
  assert.equal(result.elevated.suppliedRunIgnored, true)
  assert.equal(result.elevated.scenarios, undefined)
})

test('基线和压力情景均通过后才输出研究档风险收益差异', () => {
  const value = experiment({
    BASELINE: runSet('BASELINE'),
    ELEVATED_RESEARCH: runSet('ELEVATED_RESEARCH', {
      quantityShares: 200,
    }),
  })
  const first = evaluateProfitabilityExperiment(value)
  const second = evaluateProfitabilityExperiment(value)

  assert.equal(first.baseline.status, 'BASELINE_QUALIFIED')
  assert.equal(
    first.elevated.status,
    'ELEVATED_RESEARCH_COMPLETE',
  )
  assert.ok(first.elevated.comparison.netPnlDeltaCents > 0)
  assert.equal(
    first.elevated.comparison.modelImprovementClaimed,
    false,
  )
  assert.equal(
    first.elevated.comparison.interpretation,
    'RISK_PROFILE_COMPARISON_ONLY',
  )
  assert.equal(first.absoluteCap.productionAuthorized, false)
  assert.equal(first.resultHash, second.resultHash)
})

test('双倍滑点或下一开盘退出失去正收益时基线不合格', () => {
  const result = evaluateProfitabilityExperiment(experiment({
    BASELINE: runSet('BASELINE', {
      sellPrice: 11,
      stressSellPrice: 9,
    }),
  }))

  assert.equal(result.baseline.status, 'BASELINE_REJECTED')
  assert.ok(result.baseline.blockers.includes(
    'EXECUTION_STRESS_REMOVES_ADVANTAGE',
  ))
})

test('任一账户账本无法按分复算时拒绝基线', () => {
  const baseline = runSet('BASELINE')
  baseline.primary.accountState.cashCents += 1
  const result = evaluateProfitabilityExperiment(experiment({
    BASELINE: baseline,
  }))

  assert.equal(result.baseline.status, 'BASELINE_REJECTED')
  assert.ok(result.baseline.blockers.includes(
    'primary:LEDGER_AUDIT_FAILED',
  ))
})

test('风险标签与实际风险证据不一致时拒绝场景', () => {
  const baseline = runSet('BASELINE')
  baseline.primary.riskEvidence.maximumOpenRiskPct = null
  const result = evaluateProfitabilityExperiment(experiment({
    BASELINE: baseline,
  }))

  assert.equal(result.baseline.status, 'BASELINE_REJECTED')
  assert.ok(result.baseline.blockers.includes(
    'primary:RISK_EVIDENCE_REQUIRED',
  ))
})
