import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceEvidenceDigest,
  adviceTrustBands,
  calibrateAdviceTrust,
  evaluateScheduledReview,
  prioritizeAdviceReviewCodes,
} from '../shared/adviceIntelligence.js'
import { buildAdviceCacheEntry } from '../shared/adviceContinuity.js'

function snapshot(overrides = {}) {
  return {
    freshness: { status: 'LIVE', missingSources: [] },
    account: {
      holdQty: 3,
      sellableTodayQty: 2,
      stockWeight: 18,
      cashReservePct: 35,
    },
    evidence: {
      quote: { price: 10, pct: 1.2 },
      market: { environment: { score: 55, level: '中性' } },
      technical: {
        indicators: { maTrend: '多头', maCross: '金叉' },
        intraday: { vsVwap: '上方', posInDay: 60 },
      },
      funds: { mainNetYi: 0.5, main5dYi: 1.2, mainStreak: 2 },
      quant: {
        score: 68,
        bias: '看涨',
        forecast: { direction: '上涨', upProb: 58 },
        highConfSignal: { fired: false },
      },
      news: { headlines: [{ title: '公司订单稳定增长' }] },
      decisionSignals: {
        resonance: { score: 4, hasNegNews: false },
      },
    },
    ...overrides,
  }
}

test('快速轮只有量化结果时保留上一版完整军师建议', () => {
  const previous = {
    at: 1000,
    advice: {
      action: '持有',
      actionPlan: '守住9.80元继续持有',
      reasoning: '上一版完整分析',
      continuity: { planId: 'plan-1', revision: 2 },
    },
  }

  const next = buildAdviceCacheEntry(previous, {
    mode: 'hold_advice',
    result: { score: 66 },
    advice: null,
    reviewDisposition: 'insufficient',
    reviewReason: '量化以外关键证据不完整',
  }, 2000)

  assert.equal(next.advice.action, '持有')
  assert.equal(next.advice.reasoning, '上一版完整分析')
  assert.equal(next.result.score, 66)
  assert.equal(next.advice.reviewCycle.status, 'insufficient')
})

test('自动复核证据无实质变化时跳过LLM', () => {
  const previous = adviceEvidenceDigest(snapshot())
  const current = snapshot({
    evidence: {
      ...snapshot().evidence,
      quote: { price: 10.02, pct: 1.3 },
    },
  })

  assert.deepEqual(evaluateScheduledReview({
    origin: 'auto',
    previousDigest: previous,
    snapshot: current,
    hasPreviousAdvice: true,
  }), {
    shouldRunLLM: false,
    disposition: 'unchanged',
    reason: '关键证据无实质变化',
  })
})

test('价格门槛按个股ATR自适应而不是固定0.4%', () => {
  const highVolatility = snapshot({
    evidence: {
      ...snapshot().evidence,
      technical: {
        ...snapshot().evidence.technical,
        indicators: {
          ...snapshot().evidence.technical.indicators,
          atr: { atr: 0.5 },
        },
      },
    },
  })
  const current = snapshot({
    evidence: {
      ...highVolatility.evidence,
      quote: { price: 10.05, pct: 1.3 },
    },
  })

  assert.equal(evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(highVolatility),
    snapshot: current,
    hasPreviousAdvice: true,
  }).disposition, 'unchanged')
})

test('高波动股票穿越止损位仍立即进入实质变化复核', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      quote: { price: 9.85, pct: -1.2 },
      technical: {
        ...snapshot().evidence.technical,
        indicators: {
          ...snapshot().evidence.technical.indicators,
          atr: { atr: 0.5 },
        },
      },
    },
  })
  const current = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      quote: { price: 9.79, pct: -1.3 },
    },
  })
  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: current,
    hasPreviousAdvice: true,
    previousAdvice: {
      action: '持有',
      stopPrice: 9.8,
      targetPrice: 10.8,
    },
  })

  assert.equal(result.disposition, 'material-change')
  assert.match(result.reason, /止损/)
})

test('关键证据缺失时保留上一版而不是让LLM猜测', () => {
  const partial = snapshot({
    freshness: { status: 'PARTIAL', missingSources: ['quant'] },
  })

  assert.deepEqual(evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(snapshot()),
    snapshot: partial,
    hasPreviousAdvice: true,
  }), {
    shouldRunLLM: false,
    disposition: 'insufficient',
    reason: '关键证据缺失：quant',
  })
})

test('价格、方向或负面证据发生实质变化时继续调用LLM', () => {
  const changed = snapshot({
    evidence: {
      ...snapshot().evidence,
      quote: { price: 10.12, pct: 2.4 },
      decisionSignals: {
        resonance: { score: 2, hasNegNews: true },
      },
    },
  })
  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(snapshot()),
    snapshot: changed,
    hasPreviousAdvice: true,
  })

  assert.equal(result.shouldRunLLM, true)
  assert.equal(result.disposition, 'material-change')
})

test('宏观消息、资金幅度和技术指标变化不能被误判为无变化', () => {
  const previous = adviceEvidenceDigest(snapshot())
  const changed = snapshot({
    evidence: {
      ...snapshot().evidence,
      technical: {
        ...snapshot().evidence.technical,
        indicators: {
          ...snapshot().evidence.technical.indicators,
          rsi: 72,
          macd: { hist: -0.12 },
          boll: { pctB: 92 },
        },
      },
      funds: {
        ...snapshot().evidence.funds,
        mainNetYi: 1.4,
        main5dYi: 2.1,
      },
      news: {
        ...snapshot().evidence.news,
        macro: ['海外市场突发大幅波动'],
        industry: ['行业监管政策调整'],
      },
    },
  })

  assert.equal(evaluateScheduledReview({
    origin: 'auto',
    previousDigest: previous,
    snapshot: changed,
    hasPreviousAdvice: true,
  }).disposition, 'material-change')
})

test('高信心档历史表现较差时收缩当前信心而不是继续过度自信', () => {
  const calibrated = calibrateAdviceTrust(82, [{
    band: 'high',
    total: 14,
    winRate: 43,
    avgPct: -0.8,
  }])

  assert.equal(calibrated.calibrated, true)
  assert.ok(calibrated.score <= 60)
  assert.equal(calibrated.sampleSize, 14)
  assert.equal(calibrated.historicalWinRate, 43)
})

test('历史信心档统一投影给手动和自动军师链路', () => {
  assert.deepEqual(adviceTrustBands({
    byTrust: [{
      band: 'high',
      total: 14,
      winRate: 43,
      avgPct: -0.8,
      hit: 6,
    }],
  }), [{
    band: 'high',
    total: 14,
    winRate: 43,
    avgPct: -0.8,
  }])
})

test('自动复核优先观察确认中、持仓、重点关注和逾期更久的股票', () => {
  const ordered = prioritizeAdviceReviewCodes({
    codes: ['000001', '600001', '600000', '000002'],
    holdingCodes: ['600000', '600001'],
    starredCodes: ['000002'],
    alerts: [{ code: '600001', phase: 'watching', enabled: true }],
    advice: {
      '600000': { advice: { reviewCycle: { nextReviewAt: 900 } } },
      '600001': { advice: { reviewCycle: { nextReviewAt: 950 } } },
      '000001': { advice: { reviewCycle: { nextReviewAt: 800 } } },
      '000002': { advice: { reviewCycle: { nextReviewAt: 990 } } },
    },
    now: 1000,
  })

  assert.deepEqual(ordered, ['600001', '600000', '000002', '000001'])
})
