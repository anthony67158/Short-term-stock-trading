import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStrategyRoutingContext,
  routeStrategyPortfolio,
} from '../shared/strategyRouter.js'
import {
  buildDefaultStrategyGovernance,
} from '../shared/strategyGovernanceV2.js'

const trendContext = {
  marketRegime: 'TREND_STRONG',
  marketScore: 76,
  pct: 3,
  volRatio: 1.8,
  amount: 2e8,
  quant: { score: 72 },
  relativeStrength20: 75,
  sector: { breadth: 68 },
  technical: {
    donchianBreakout: true,
    maSlope20: 0.8,
    structureBreak: false,
    atrStopBroken: false,
  },
}

test('默认策略均不能影响生产但会输出可解释的研究路由', () => {
  const route = routeStrategyPortfolio({
    marketRegime: 'TREND_STRONG',
    context: trendContext,
    requestedAction: 'BUY',
  })

  assert.equal(route.schemaVersion, 'strategy-route.v1')
  assert.equal(route.production, null)
  assert.equal(route.research.strategyId, 'trend-breakout')
  assert.equal(route.research.actionability, 'SHADOW_ONLY')
  assert.ok(route.candidates.every(
    (item) => item.productionEligible === false,
  ))
})

test('RANGE只路由震荡策略且必须有底仓', () => {
  const rangeContext = {
    marketRegime: 'RANGE',
    account: { hasBasePosition: false },
    quant: { score: 60 },
    technical: {
      bollPct: 0.2,
      rsi6: 35,
      vwapDeviationPct: -1,
      atrPct: 2,
    },
  }
  const noBase = routeStrategyPortfolio({
    marketRegime: 'RANGE',
    context: rangeContext,
    requestedAction: 'T_BUY_FIRST',
  })
  const withBase = routeStrategyPortfolio({
    marketRegime: 'RANGE',
    context: {
      ...rangeContext,
      account: { hasBasePosition: true },
    },
    requestedAction: 'T_BUY_FIRST',
  })

  assert.equal(noBase.research, null)
  assert.equal(withBase.research.strategyId, 'range-mean-reversion')
})

test('硬退出路由优先于收益排序且少量样本不放大权重', () => {
  const governance = buildDefaultStrategyGovernance()
  governance.strategies = governance.strategies.map((record) => ({
    ...record,
    state: 'shadow',
    blockers: [],
    shadow: {
      samples: record.strategyId === 'trend-breakout' ? 3 : 40,
      netReturn: record.strategyId === 'trend-breakout' ? 0.8 : 0.02,
      maximumDrawdown: -0.03,
      profitFactor: 1.3,
    },
  }))
  const trend = routeStrategyPortfolio({
    marketRegime: 'TREND_STRONG',
    context: trendContext,
    governance,
    requestedAction: 'BUY',
  })
  const risk = routeStrategyPortfolio({
    marketRegime: 'RISK_OFF',
    context: {
      ...trendContext,
      marketRegime: 'RISK_OFF',
      technical: {
        ...trendContext.technical,
        structureBreak: true,
      },
    },
    governance,
    requestedAction: 'EXIT',
  })

  const trendCandidate = trend.candidates.find(
    (item) => item.strategyId === 'trend-breakout',
  )
  assert.equal(trendCandidate.shadowPerformanceEligible, false)
  assert.equal(trendCandidate.shadowScore, 0)
  assert.equal(risk.research.strategyId, 'defensive-exit')
})

test('只有同版本已批准 active 策略可以进入生产路由', () => {
  const governance = buildDefaultStrategyGovernance()
  governance.strategies = governance.strategies.map((record) => {
    if (record.strategyId !== 'trend-breakout') return record
    return {
      ...record,
      state: 'active',
      blockers: [],
      artifactHash: `sha256:${'a'.repeat(64)}`,
      approval: {
        specVersion: record.specVersion,
        approvedBy: 'owner',
        approvedAt: 1,
      },
      productionGate: {
        productionEligible: true,
        specVersion: record.specVersion,
      },
    }
  })
  const route = routeStrategyPortfolio({
    marketRegime: 'TREND_STRONG',
    context: trendContext,
    governance,
    requestedAction: 'BUY',
  })

  assert.equal(route.production.strategyId, 'trend-breakout')
  assert.equal(route.production.actionability, 'READY')
})

test('路由上下文只投影已知证据字段', () => {
  const context = buildStrategyRoutingContext({
    todayQuote: {
      amount: 2e8,
      pct: 2.1,
      volRatio: 1.7,
    },
    stockFund: { mainRatio: 4.5 },
    quant: { score: 68 },
    tech: {
      atrPct: 2.2,
      rsi6: 38,
      donchianBreakout: true,
    },
    holdQty: 2,
    unsafe: { secret: 'do-not-project' },
  }, { regime: 'TREND_STRONG', score: 72 })

  assert.equal(context.marketRegime, 'TREND_STRONG')
  assert.equal(context.account.hasBasePosition, true)
  assert.equal(context.technical.rsi6, 38)
  assert.equal(context.unsafe, undefined)
})
