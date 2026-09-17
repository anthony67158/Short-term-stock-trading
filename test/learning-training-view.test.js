import test from 'node:test'
import assert from 'node:assert/strict'

import {
  publishLearningTrainingView,
} from '../api/_learning_training_view.js'
import {
  LEARNING_EVENT_KIND,
} from '../shared/learningEvent.js'

function storeWith(events) {
  const artifacts = new Map()
  return {
    artifacts,
    async listEvents({ kind }) {
      return events.filter((event) => event.kind === kind)
    },
    async saveArtifact(path, value) {
      const saved = { ...value, contentHash: `hash:${path}` }
      artifacts.set(path, saved)
      return saved
    },
  }
}

test('训练视图只包含成熟样本并发布带计数的不可变清单', async () => {
  const prediction = {
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    eventId: 'prediction-1',
    tradeDate: '2026-09-10',
    payload: { modelVersion: 'ranking-v1' },
  }
  const stockOutcome = {
    kind: LEARNING_EVENT_KIND.OUTCOME,
    eventId: 'outcome-1',
    tradeDate: '2026-09-10',
    payload: {
      outcomeType: 'STOCK_PICK_T5',
      code: '600000',
      rankingScore: 0.8,
      returnPct: 5,
      mfePct: 6,
      maePct: -1,
      directionHit: true,
      positive2PctHit: true,
      targetDate: '2026-09-17',
    },
    lineage: { predictionEventId: 'prediction-1' },
  }
  const positionPrediction = {
    kind: LEARNING_EVENT_KIND.POSITION_PREDICTION,
    eventId: 'position:decision-1',
    sourceId: 'decision-1',
    tradeDate: '2026-09-17',
    payload: {
      code: '600001',
      action: '减仓',
      mode: 'holding',
      referencePrice: 10.2,
      stopLoss: 9.8,
      takeProfit: 10.8,
      pFill: 0.8,
      pWinGivenFill: 0.6,
      expectedNetR: 0.4,
      modelVersion: 'position-v1',
    },
  }
  const positionOutcome = {
    kind: LEARNING_EVENT_KIND.OUTCOME,
    eventId: 'position-outcome-1',
    tradeDate: '2026-09-17',
    accountHash: 'account-hash',
    payload: {
      outcomeType: 'POSITION_ACTUAL',
      decisionId: 'decision-1',
      code: '600001',
      action: '减仓',
      side: 'SELL',
      status: 'COMPLETED',
      filledLots: 2,
      fillRatePct: 100,
      totalFees: 6,
      netPnl: 120,
      plannedExpectedNetR: 0.4,
      realizedNetR: 0.6,
      expectancyErrorR: 0.2,
    },
  }
  const store = storeWith([
    prediction,
    positionPrediction,
    stockOutcome,
    positionOutcome,
  ])

  const result = await publishLearningTrainingView({
    store,
    now: Date.parse('2026-09-17T09:20:00Z'),
  })

  assert.equal(result.view.stockPick.length, 1)
  assert.equal(result.view.position.length, 1)
  assert.equal(result.view.position[0].expectedNetR, 0.4)
  assert.equal(result.view.position[0].realizedNetR, 0.6)
  assert.equal(
    Object.hasOwn(result.view.position[0], 'filledLots'),
    false,
  )
  assert.deepEqual(result.manifest.samples, {
    stockPick: 1,
    position: 1,
    total: 2,
  })
  assert.equal(
    [...store.artifacts.keys()].every((path) =>
      path.startsWith('learning/v1/')
    ),
    true,
  )
})
