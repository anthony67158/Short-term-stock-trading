import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRealOutcomeLearning,
  realOutcomeContext,
} from '../shared/realOutcomeLearning.js'

function recommendation(id, {
  mode = 'buy_advice',
  action = '立即买入',
  marketRegime = '弱市',
  tacticalState = 'READY',
  tacticalHorizon = 'INTRADAY',
  tacticalTriggerPath = 'DIRECT',
} = {}) {
  return {
    id,
    kind: 'recommendation',
    code: '600001',
    mode,
    action,
    marketRegime,
    tacticalState,
    tacticalHorizon,
    tacticalTriggerPath,
    at: 100,
  }
}

function execution(id, recommendationId, pnl, {
  transactionId = id,
  validationComplete = true,
  holdingDurationMinutes = null,
  mfePct = null,
  maePct = null,
  profitCapturePct = null,
} = {}) {
  return {
    id,
    transactionId,
    kind: 'execution',
    code: '600001',
    side: 'sell',
    linkedRecommendationId: recommendationId,
    at: 200,
    outcome: {
      pnl,
      validationComplete,
      holdingDurationMinutes,
      mfePct,
      maePct,
      profitCapturePct,
    },
  }
}

test('真实收益画像只统计已关联且完成验证的真实费后卖出', () => {
  const data = {
    adviceLog: [{
      id: 'unexecuted-advice',
      verified: true,
      hit: true,
      resultPct: 20,
    }],
    decisionLog: [
      recommendation('r1'),
      recommendation('r2'),
      recommendation('r3'),
      execution('e1', 'r1', 120),
      execution('e2', 'r2', -40),
      execution('e-pending', 'r3', 500, { validationComplete: false }),
      {
        ...execution('e-no-transaction', 'r3', 300),
        transactionId: undefined,
      },
      {
        id: 'e-unlinked',
        transactionId: 'tx-unlinked',
        kind: 'execution',
        side: 'sell',
        outcome: { pnl: 999, validationComplete: true },
      },
    ],
  }

  const profile = buildRealOutcomeLearning(data, { minimumSamples: 2 })

  assert.equal(profile.schemaVersion, 'real-outcome-learning.v1')
  assert.equal(profile.overall.samples, 2)
  assert.equal(profile.overall.netPnl, 80)
  assert.equal(profile.overall.wins, 1)
  assert.equal(profile.overall.losses, 1)
  assert.equal(profile.overall.profitFactor, 3)
  assert.equal(profile.groups.actions[0].samples, 2)
  assert.equal(profile.groups.tacticalStates[0].key, 'READY')
  assert.equal(profile.groups.tacticalHorizons[0].key, 'INTRADAY')
  assert.equal(profile.groups.tacticalTriggerPaths[0].key, 'DIRECT')
  assert.equal(profile.excluded.unexecutedAdviceOutcomes, 1)
  assert.equal(profile.excluded.incompleteExecutions, 1)
  assert.equal(profile.excluded.unlinkedExecutions, 1)
  assert.equal(profile.excluded.missingTransactionId, 1)
})

test('重复交易流水按 transactionId 只保留最新版本', () => {
  const original = execution('e-old', 'r1', 100, { transactionId: 'tx1' })
  const edited = {
    ...execution('e-new', 'r1', -20, { transactionId: 'tx1' }),
    at: 300,
  }

  const profile = buildRealOutcomeLearning({
    decisionLog: [recommendation('r1'), original, edited],
  }, { minimumSamples: 1 })

  assert.equal(profile.overall.samples, 1)
  assert.equal(profile.overall.netPnl, -20)
  assert.equal(profile.overall.wins, 0)
})

test('做T卖腿不会误计为普通减仓或清仓的收益学习样本', () => {
  const tExecution = {
    ...execution('e-t', 'r1', 80),
    tradeIntent: 't',
  }
  const profile = buildRealOutcomeLearning({
    decisionLog: [recommendation('r1'), tExecution],
  }, { minimumSamples: 1 })

  assert.equal(profile.overall.samples, 0)
  assert.equal(profile.excluded.tradeIntentT, 1)
})

test('上下文只在同模式同市场样本足够时约束风险倍率', () => {
  const decisionLog = [
    recommendation('r1'),
    recommendation('r2'),
    execution('e1', 'r1', -100),
    execution('e2', 'r2', -50),
  ]
  const profile = buildRealOutcomeLearning(
    { decisionLog },
    { minimumSamples: 2 },
  )

  const matched = realOutcomeContext(profile, {
    mode: 'buy_advice',
    marketRegime: '弱市',
  })
  const unmatched = realOutcomeContext(profile, {
    mode: 'hold_advice',
    marketRegime: '强市',
  })
  const tactical = realOutcomeContext(profile, {
    mode: 'buy_advice',
    marketRegime: '强市',
    tacticalState: 'READY',
  })

  assert.equal(matched.sampleQualified, true)
  assert.equal(matched.calibration, 'defensive')
  assert.equal(matched.riskScale, 0.6)
  assert.equal(unmatched.sampleQualified, false)
  assert.equal(unmatched.riskScale, 1)
  assert.equal(tactical.scope, 'mode_tactical')
  assert.equal(tactical.sampleQualified, true)
  assert.equal(tactical.riskScale, 0.6)
})

test('真实学习聚合持有时长MFE、MAE与盈利捕获率', () => {
  const profile = buildRealOutcomeLearning({
    decisionLog: [
      recommendation('r1'),
      recommendation('r2'),
      execution('e1', 'r1', 120, {
        holdingDurationMinutes: 180,
        mfePct: 8,
        maePct: -2,
        profitCapturePct: 62.5,
      }),
      execution('e2', 'r2', 80, {
        holdingDurationMinutes: 300,
        mfePct: 6,
        maePct: -1,
        profitCapturePct: 50,
      }),
    ],
  }, { minimumSamples: 2 })

  assert.equal(profile.overall.averageHoldingMinutes, 240)
  assert.equal(profile.overall.averageMfePct, 7)
  assert.equal(profile.overall.averageMaePct, -1.5)
  assert.equal(profile.overall.averageProfitCapturePct, 56.3)

  const context = realOutcomeContext(profile, {
    mode: 'buy_advice',
    tacticalState: 'READY',
  })
  assert.equal(context.averageHoldingMinutes, 240)
  assert.equal(context.averageMfePct, 7)
  assert.equal(context.averageMaePct, -1.5)
  assert.equal(context.averageProfitCapturePct, 56.3)
})

test('缺少真实价格路径时MFE与MAE保持空值', () => {
  const profile = buildRealOutcomeLearning({
    decisionLog: [
      recommendation('r1'),
      execution('e1', 'r1', 120, {
        holdingDurationMinutes: 180,
      }),
    ],
  }, { minimumSamples: 1 })

  assert.equal(profile.overall.averageHoldingMinutes, 180)
  assert.equal(profile.overall.averageMfePct, null)
  assert.equal(profile.overall.averageMaePct, null)
  assert.equal(profile.overall.averageProfitCapturePct, null)
})
