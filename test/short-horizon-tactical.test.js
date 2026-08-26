import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SHORT_HORIZON_TACTICAL_VERSION,
  attachShortHorizonSummary,
  buildShortHorizonTactical,
} from '../shared/shortHorizonTactical.js'

function payload(overrides = {}) {
  return {
    todayQuote: {
      price: 100,
      pct: 2,
      low: 97,
      high: 104,
      turnover: 5,
      volRatio: 1.8,
      live: true,
      phase: '上午盘中',
    },
    marketEnv: {
      score: 70,
      weak: false,
      allowRiskIncrease: true,
    },
    sectorOpportunity: {
      matched: true,
      sector: { actionability: '可买' },
      stock: { roleLabel: '前排龙头', score: 68 },
    },
    stockFund: {
      mainNetYi: 1.2,
      retailNetYi: -0.6,
    },
    quant: {
      score: 64,
      forecast: { direction: '看涨', upProb: 62 },
      highConfSignal: { fired: true },
    },
    tech: {
      atr: 2,
      support: 97,
      resistance: 104,
      rsi: 58,
    },
    intraday: {
      posInDay: 55,
    },
    ...overrides,
  }
}

test('强市场前排个股与主力吸筹投影为短线可行动状态', () => {
  const result = buildShortHorizonTactical(payload(), {
    now: Date.parse('2026-08-26T02:30:00.000Z'),
  })

  assert.equal(result.schemaVersion, SHORT_HORIZON_TACTICAL_VERSION)
  assert.equal(result.market.riskTone, 'RISK_ON')
  assert.equal(result.sector.state, 'LEADING')
  assert.equal(result.sector.stockRole, 'LEADER')
  assert.equal(result.flow.relation, 'ACCUMULATION')
  assert.equal(result.timing.state, 'READY')
  assert.equal(result.horizon, 'INTRADAY')
  assert.equal(result.conflicts.length, 0)
})

test('高位拥挤即使量化偏多也等待回踩并显式记录冲突', () => {
  const result = buildShortHorizonTactical(payload({
    todayQuote: {
      price: 100,
      pct: 9,
      low: 96,
      high: 101,
      turnover: 20,
      volRatio: 5.5,
      live: true,
      phase: '上午盘中',
    },
    intraday: { posInDay: 96 },
    tech: {
      atr: 3,
      support: 96,
      resistance: 101,
      rsi: 82,
    },
  }))

  assert.equal(result.stock.location, 'EXTENDED')
  assert.equal(result.stock.crowdingRisk, 'HIGH')
  assert.equal(result.timing.state, 'TOO_EXTENDED')
  assert.match(result.conflicts.join('；'), /量化偏多/)
})

test('主力流出且小单流入明确识别为派发风险', () => {
  const result = buildShortHorizonTactical(payload({
    stockFund: {
      mainNetYi: -1.5,
      retailNetYi: 1.1,
    },
  }))

  assert.equal(result.flow.mainDirection, 'OUTFLOW')
  assert.equal(result.flow.retailDirection, 'INFLOW')
  assert.equal(result.flow.relation, 'DISTRIBUTION')
})

test('远端复权支撑不进入战术路径并回退近期真实高低点', () => {
  const result = buildShortHorizonTactical(payload({
    todayQuote: {
      price: 128.61,
      pct: 0.5,
      low: 126.8,
      high: 130.2,
      turnover: 3,
      volRatio: 1.2,
      live: true,
      phase: '上午盘中',
    },
    tech: {
      atr: 3,
      support: 89.09,
      resistance: 89.09,
      rsi: 55,
    },
  }))

  assert.equal(result.timing.pullbackPrice, 126.8)
  assert.equal(result.timing.breakoutPrice, 130.2)
  assert.notEqual(result.timing.pullbackPrice, 89.09)
})

test('行情缺失时战术状态不可执行', () => {
  const result = buildShortHorizonTactical(payload({
    todayQuote: {},
    intraday: {},
  }))

  assert.equal(result.timing.state, 'INVALID')
  assert.equal(result.stock.location, 'UNKNOWN')
})

test('模型漏填短线摘要时由战术合同补齐用户字段', () => {
  const tactical = buildShortHorizonTactical(payload())
  const result = attachShortHorizonSummary({
    action: '观望',
  }, tactical)

  assert.equal(result.shortHorizon, '盘中')
  assert.match(result.edge, /板块前排|主力承接/)
  assert.ok(result.crowdingRisk)
  assert.ok(result.catalystWindow)
  assert.ok(result.reviewTrigger)
  assert.equal(
    result.shortHorizonTactical.schemaVersion,
    SHORT_HORIZON_TACTICAL_VERSION,
  )
})

test('账号内首要轮动只以机会成本摘要进入单股战术合同', () => {
  const tactical = buildShortHorizonTactical(payload({
    opportunityCost: {
      status: 'READY',
      actionable: true,
      sourceCode: '600000',
      targetCode: '000001',
      targetName: '平安银行',
      edgeScore: 12.4,
      tradingCost: 35.67,
      generatedAt: 1787700000000,
      ignored: '不应透传',
    },
  }))

  assert.deepEqual(tactical.opportunityCost, {
    status: 'READY',
    actionable: true,
    targetCode: '000001',
    targetName: '平安银行',
    edgeScore: 12.4,
    tradingCost: 35.67,
    generatedAt: 1787700000000,
  })
})
