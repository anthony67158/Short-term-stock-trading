import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStrategyRadar,
  strategyShadowMetrics,
} from '../shared/strategyRadar.js'

test('策略雷达分别解释持仓管理与自选买入影响', () => {
  const radar = buildStrategyRadar({
    holdings: [{
      code: '000001',
      name: '演示持仓',
    }],
    watchlist: [{
      code: '002594',
      name: '演示自选',
    }],
    advice: {
      '000001': {
        at: 200,
        mode: 'hold_advice',
        meta: {
          marketEnv: { regime: 'RISK_OFF' },
        },
        advice: {
          action: '减仓',
          actionPlan: '跌破防守线后减仓1手',
          decisionPlan: {
            action: 'REDUCE',
            actionability: 'READY',
            strategy: {
              strategyId: 'defensive-exit',
              name: '防守退出',
              routeMode: 'SHADOW_ONLY',
              signalPassed: true,
            },
          },
        },
      },
      '002594': {
        at: 100,
        mode: 'buy_advice',
        meta: {
          marketEnv: { regime: 'TREND_STRONG' },
        },
        advice: {
          action: '回调再买',
          actionPlan: '回踩企稳后再考虑买入',
          decisionPlan: {
            action: 'BUY',
            actionability: 'RESEARCH_ONLY',
            strategy: {
              strategyId: 'trend-breakout',
              name: '趋势突破',
              routeMode: 'SHADOW_ONLY',
              signalPassed: true,
            },
          },
        },
      },
    },
  })

  assert.equal(radar.schemaVersion, 'strategy-radar.v1')
  assert.equal(radar.marketRegime, 'RISK_OFF')
  assert.equal(radar.holdings[0].actionLabel, '优先降低风险')
  assert.equal(radar.holdings[0].canIncreaseRisk, false)
  assert.equal(radar.watchlist[0].actionLabel, '等待条件确认')
  assert.equal(radar.watchlist[0].canIncreaseRisk, false)
  assert.equal(radar.summary.matchedStrategies, 2)
  assert.equal(radar.summary.holdingActions, 1)
  assert.equal(radar.summary.watchCandidates, 1)
})

test('策略模拟表现直接从去重后的已验证建议结果累计', () => {
  const metrics = strategyShadowMetrics([
    {
      id: 'a',
      code: '000001',
      mode: 'buy_advice',
      action: '买入',
      strategyId: 'trend-breakout',
      specVersion: 'v1',
      verified: true,
      outcomePolicyVersion: 2,
      hit: true,
      resultPct: 5,
      at: 100,
    },
    {
      id: 'a-newer',
      code: '000001',
      mode: 'buy_advice',
      action: '买入',
      strategyId: 'trend-breakout',
      specVersion: 'v1',
      verified: true,
      outcomePolicyVersion: 2,
      hit: true,
      resultPct: 5,
      at: 101,
    },
    {
      id: 'b',
      code: '000002',
      mode: 'buy_advice',
      action: '买入',
      strategyId: 'trend-breakout',
      specVersion: 'v1',
      verified: true,
      outcomePolicyVersion: 2,
      hit: false,
      resultPct: -2,
      at: 200,
    },
    {
      id: 'pending',
      code: '000003',
      mode: 'buy_advice',
      action: '买入',
      strategyId: 'trend-breakout',
      specVersion: 'v1',
      verified: false,
      at: 300,
    },
  ], {
    strategyId: 'trend-breakout',
    specVersion: 'v1',
  })

  assert.equal(metrics.samples, 2)
  assert.equal(metrics.pending, 1)
  assert.equal(metrics.netReturn, 0.029)
  assert.equal(metrics.maximumDrawdown, -0.02)
  assert.equal(metrics.profitFactor, 2.5)
})
