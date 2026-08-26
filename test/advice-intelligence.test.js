import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceEvidenceDigest,
  adviceTrustBands,
  buildReviewReceipt,
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

function priceContract(levels = []) {
  return {
    schemaVersion: 'advice-price-contract.v1',
    validationStatus: 'VERIFIED',
    levels,
    allPricesStrict: true,
    issues: [],
    review: { operator: 'ALL', conditions: [], allMet: false },
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

test('短线战术状态变化优先触发复核', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      decisionSignals: {
        ...snapshot().evidence.decisionSignals,
        tactical: {
          horizon: 'INTRADAY',
          market: { riskTone: 'BALANCED' },
          sector: { state: 'CONFIRMING', stockRole: 'FRONT_ROW' },
          stock: { location: 'MID', crowdingRisk: 'LOW' },
          flow: { relation: 'ACCUMULATION' },
          timing: { state: 'READY' },
          catalyst: { freshness: 'FRESH', risk: 'POSITIVE' },
          quant: { highConfidence: true },
          conflicts: [],
        },
      },
    },
  })
  const currentSnapshot = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      decisionSignals: {
        ...previousSnapshot.evidence.decisionSignals,
        tactical: {
          ...previousSnapshot.evidence.decisionSignals.tactical,
          stock: { location: 'EXTENDED', crowdingRisk: 'HIGH' },
          timing: { state: 'TOO_EXTENDED' },
          conflicts: ['量化偏多，但当前价格过热'],
        },
      },
    },
  })

  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: currentSnapshot,
    hasPreviousAdvice: true,
  })

  assert.equal(result.shouldRunLLM, true)
  assert.match(result.reason, /短线战术状态/)
})

test('宏观快讯轮换和无关研报不应单独触发自动复核模型', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      news: {
        headlines: [
          '[公司公告]测试股份：季度经营数据',
          '[研报]与本股无关的公司报告A',
        ],
        macro: ['海外宏观快讯A'],
        flashes: ['市场快讯A'],
      },
    },
  })
  const currentSnapshot = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      news: {
        headlines: [
          '[公司公告]测试股份：季度经营数据',
          '[研报]与本股无关的公司报告B',
        ],
        macro: ['海外宏观快讯B'],
        flashes: ['市场快讯B'],
      },
    },
  })

  assert.deepEqual(evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: currentSnapshot,
    hasPreviousAdvice: true,
  }), {
    shouldRunLLM: false,
    disposition: 'unchanged',
    reason: '关键证据无实质变化',
  })
})

test('同方向的资金金额和量化分微调不应重复调用自动复核模型', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      funds: {
        ...snapshot().evidence.funds,
        mainNetYi: 0.42,
        main5dYi: 1.1,
        retailNetYi: -0.35,
        retailFlow: { relation: 'main_in_retail_out' },
      },
      quant: {
        ...snapshot().evidence.quant,
        score: 66,
        forecast: { direction: '上涨', upProb: 57 },
      },
    },
  })
  const currentSnapshot = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      funds: {
        ...previousSnapshot.evidence.funds,
        mainNetYi: 0.9,
        main5dYi: 1.6,
        retailNetYi: -0.1,
        retailFlow: { relation: 'main_in_retail_out' },
      },
      quant: {
        ...previousSnapshot.evidence.quant,
        score: 69,
        forecast: { direction: '上涨', upProb: 59 },
      },
    },
  })

  assert.equal(evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: currentSnapshot,
    hasPreviousAdvice: true,
  }).disposition, 'unchanged')
})

test('板块参与资格或资金结构变化但未触发执行价时只加快观察', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      funds: {
        ...snapshot().evidence.funds,
        retailNetYi: -0.8,
        retailFlow: { relation: 'main_in_retail_out' },
      },
      decisionSignals: {
        ...snapshot().evidence.decisionSignals,
        sectorOpportunity: {
          matched: true,
          probeEligible: false,
          sector: { actionability: 'WAIT_PULLBACK' },
          stock: { role: 'core', score: 60, mainInflow: 0.2 },
        },
      },
    },
  })
  const currentSnapshot = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      funds: {
        ...previousSnapshot.evidence.funds,
        mainNetYi: -1,
        retailNetYi: 1.2,
        retailFlow: { relation: 'main_out_retail_in' },
      },
      decisionSignals: {
        ...previousSnapshot.evidence.decisionSignals,
        sectorOpportunity: {
          matched: true,
          probeEligible: true,
          sector: { actionability: 'LAYOUT' },
          stock: { role: 'leader', score: 78, mainInflow: 1.5 },
        },
      },
    },
  })

  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: currentSnapshot,
    hasPreviousAdvice: true,
  })

  assert.equal(result.shouldRunLLM, false)
  assert.equal(result.disposition, 'unchanged')
  assert.match(result.reason, /执行价|风险事件/)
})

test('板块与资金确认且接近执行价时触发自动复核模型', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      quote: { price: 10.2, pct: 1.2 },
      technical: {
        ...snapshot().evidence.technical,
        indicators: { ...snapshot().evidence.technical.indicators, atr: { atr: 0.2 } },
      },
    },
  })
  const currentSnapshot = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      quote: { price: 10.01, pct: 0.1 },
      decisionSignals: {
        ...previousSnapshot.evidence.decisionSignals,
        sectorOpportunity: {
          matched: true,
          probeEligible: true,
          sector: { actionability: 'LAYOUT' },
          stock: { role: 'leader', score: 78, mainInflow: 1.5 },
        },
      },
    },
  })
  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: currentSnapshot,
    hasPreviousAdvice: true,
    previousAdvice: {
      action: '观望',
      watchPrice: 10,
      priceContract: priceContract([{
        key: 'watch',
        field: 'watchPrice',
        purpose: 'REVIEW_ONLY',
        price: 10,
        direction: 'LTE',
        strict: true,
      }]),
    },
  })

  assert.equal(result.shouldRunLLM, true)
  assert.match(result.reason, /价格|执行价/)
})

test('复核回执说明已核实项与真正改变的短线证据', () => {
  const previousSnapshot = snapshot()
  const currentSnapshot = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      funds: {
        ...previousSnapshot.evidence.funds,
        mainNetYi: -0.6,
        retailNetYi: 0.8,
        retailFlow: { relation: 'main_out_retail_in' },
      },
    },
  })
  const receipt = buildReviewReceipt({
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: currentSnapshot,
    previousAdvice: {
      action: '持有',
      stopPrice: 9.8,
      targetPrice: 10.8,
    },
    evaluation: {
      shouldRunLLM: true,
      disposition: 'material-change',
      reason: '主力与小单资金结构发生变化',
    },
  })

  assert.match(receipt.summary, /资金/)
  assert.ok(receipt.checked.includes('价格与执行价'))
  assert.ok(receipt.checked.includes('板块与前排资格'))
  assert.ok(receipt.changes.includes('主力与小单资金结构变化'))
})

test('旧建议缺少价格契约时强制进入一次迁移复核', () => {
  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(snapshot()),
    snapshot: snapshot(),
    hasPreviousAdvice: true,
    previousAdvice: {
      action: '观望',
      watchPrice: 10.5,
      timing: '站上10.5元后重新判断',
    },
  })

  assert.deepEqual(result, {
    shouldRunLLM: true,
    disposition: 'material-change',
    reason: '旧建议缺少已验证价格契约',
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
      priceContract: priceContract([
        {
          key: 'stop',
          field: 'stopPrice',
          purpose: 'RISK',
          price: 9.8,
          direction: 'LTE',
          strict: true,
        },
        {
          key: 'target',
          field: 'targetPrice',
          purpose: 'OBJECTIVE',
          price: 10.8,
          direction: 'GTE',
          strict: true,
        },
      ]),
    },
  })

  assert.equal(result.disposition, 'material-change')
  assert.match(result.reason, /止损/)
})

test('观望价被精确穿越时立即进入实质变化复核', () => {
  const previousSnapshot = snapshot({
    evidence: {
      ...snapshot().evidence,
      quote: { price: 10.03, pct: 1.2 },
    },
  })
  const current = snapshot({
    evidence: {
      ...previousSnapshot.evidence,
      quote: { price: 10.05, pct: 1.2 },
    },
  })
  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(previousSnapshot),
    snapshot: current,
    hasPreviousAdvice: true,
    previousAdvice: {
      action: '观望',
      timing: '放量站上10.04元后重新判断',
      watchPrice: 10.04,
      priceContract: priceContract([{
        key: 'watch',
        field: 'watchPrice',
        purpose: 'REVIEW_ONLY',
        price: 10.04,
        direction: 'GTE',
        strict: true,
      }]),
    },
  })

  assert.equal(result.shouldRunLLM, true)
  assert.equal(result.disposition, 'material-change')
  assert.match(result.reason, /突破观察10\.04/)
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

test('未触发执行价的宏观、资金幅度和技术变化只加快观察', () => {
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

  const result = evaluateScheduledReview({
    origin: 'auto',
    previousDigest: previous,
    snapshot: changed,
    hasPreviousAdvice: true,
  })

  assert.equal(result.disposition, 'unchanged')
  assert.equal(result.shouldRunLLM, false)
  assert.match(result.reason, /执行价|风险事件/)
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
