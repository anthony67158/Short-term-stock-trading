import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPreCatalystEvaluation,
  hydratePreCatalystForecasts,
  resolvePreCatalystOutcome,
} from '../shared/preCatalystEvaluation.js'
import {
  settlePreCatalystOutcomes,
} from '../api/_pre_catalyst_settlement.js'

function bars(closes, {
  start = 3,
  amount = 200_000_000,
} = {}) {
  return closes.map((close, index) => ({
    date: `2026-09-${String(start + index).padStart(2, '0')}`,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    amount,
  }))
}

const candidate = {
  code: '300001',
  eventIds: ['CNINFO:1'],
  activationScore: 75,
  event: {
    eventId: 'CNINFO:1',
    eventType: 'ORDER',
  },
  evaluationContext: {
    signalTradeDate: '2026-09-02',
    decisionPrice: 10,
    baselineDailyAmount: 100_000_000,
  },
}

test('预催化结果使用未来五个交易日判断启动和相对收益', () => {
  const outcome = resolvePreCatalystOutcome({
    candidate,
    stockBars: bars([10.2, 10.5, 10.8, 10.7, 10.9]),
    marketBars: bars(
      [100, 100.1, 100.2, 100.3, 100.4, 100.5],
      { start: 2 },
    ),
  })

  assert.equal(outcome.mature, true)
  assert.equal(outcome.activated1d, true)
  assert.equal(outcome.activated3d, true)
  assert.ok(outcome.excessReturn5dPct > 8)
  assert.equal(outcome.outcome, 'ACTIVATED_WIN')
})

test('未来交易日不足或成交额缺失时不生成成熟标签', () => {
  const short = resolvePreCatalystOutcome({
    candidate,
    stockBars: bars([10.2, 10.3]),
    marketBars: bars([100, 100.1]),
  })
  assert.equal(short.mature, false)

  const missingAmount = resolvePreCatalystOutcome({
    candidate: {
      ...candidate,
      evaluationContext: {
        ...candidate.evaluationContext,
        baselineDailyAmount: null,
      },
    },
    stockBars: bars([10.2, 10.5, 10.8, 10.7, 10.9]),
    marketBars: bars(
      [100, 100.1, 100.2, 100.3, 100.4, 100.5],
      { start: 2 },
    ),
  })
  assert.equal(missingAmount.mature, false)
  assert.equal(missingAmount.reason, 'DATA_INCOMPLETE')
})

test('样本不足时评估保持校准中且不发布概率', () => {
  const evaluation = buildPreCatalystEvaluation([
    {
      ...resolvePreCatalystOutcome({
        candidate,
        stockBars: bars([10.2, 10.5, 10.8, 10.7, 10.9]),
        marketBars: bars(
          [100, 100.1, 100.2, 100.3, 100.4, 100.5],
          { start: 2 },
        ),
      }),
      eventType: 'ORDER',
      scoreBand: '70-79',
    },
  ])

  assert.equal(evaluation.state, 'CALIBRATING')
  assert.equal(evaluation.probabilitiesPublished, false)
  assert.equal(evaluation.sampleCount, 1)
})

test('只有成熟且达到门槛的分桶概率才回填候选', () => {
  const snapshot = {
    candidates: [{
      ...candidate,
      forecast: { state: 'CALIBRATING', sampleCount: 0 },
    }],
  }
  const evaluation = {
    state: 'READY',
    probabilitiesPublished: true,
    sampleCount: 120,
    buckets: {
      'ORDER:70-79': {
        sampleCount: 34,
        pActivation1d: 0.41,
        pActivation3d: 0.62,
        pOutperform5d: 0.57,
      },
    },
  }
  const hydrated = hydratePreCatalystForecasts(
    snapshot,
    evaluation,
  )

  assert.equal(hydrated.candidates[0].forecast.state, 'READY')
  assert.equal(hydrated.candidates[0].forecast.pActivation3d, 0.62)
  assert.equal(hydrated.candidates[0].forecast.sampleCount, 34)
})

test('预催化结算去重历史扫描并保存成熟结果与评估', async () => {
  const saved = []
  let evaluation = null
  const result = await settlePreCatalystOutcomes({
    store: {
      listRuns: async () => [{
        generatedAt: 1,
        candidates: [candidate],
      }, {
        generatedAt: 2,
        candidates: [candidate],
      }],
      listOutcomes: async () => [],
      saveOutcome: async (value) => { saved.push(value) },
      saveEvaluation: async (value) => { evaluation = value },
    },
    fetchKline: async () => ({
      candles: bars([10.2, 10.5, 10.8, 10.7, 10.9]),
    }),
    fetchIndices: async () => [{
      code: '399001',
      candles: bars(
        [100, 100.1, 100.2, 100.3, 100.4, 100.5],
        { start: 2 },
      ),
    }],
  })

  assert.equal(result.scanned, 1)
  assert.equal(result.matured, 1)
  assert.equal(saved.length, 1)
  assert.equal(evaluation.sampleCount, 1)
  assert.equal(evaluation.state, 'CALIBRATING')
})
