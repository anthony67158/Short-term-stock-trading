import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MARKET_REGIME_VERSION,
  deriveMarketRegime,
} from '../shared/marketRegime.js'
import { derivePortfolioMarketContext } from '../api/portfolio_analysis.js'

const strongMarket = {
  indices: [
    { code: '000001', name: '上证指数', pct: 1.2 },
    { code: '399001', name: '深证成指', pct: 1.8 },
    { code: '399006', name: '创业板指', pct: 2.1 },
  ],
  breadth: {
    up: 4200,
    down: 800,
    flat: 100,
    limitUp: 86,
    limitDown: 4,
    volLevel: '放量',
  },
  updatedAt: 1787353200000,
}

test('统一市场状态对相同盘面产生稳定版本和进攻结论', () => {
  const first = deriveMarketRegime(strongMarket)
  const second = deriveMarketRegime(structuredClone(strongMarket))

  assert.deepEqual(first, second)
  assert.equal(first.schemaVersion, MARKET_REGIME_VERSION)
  assert.equal(first.regime, 'TREND_STRONG')
  assert.equal(first.portfolioRegime, 'offensive')
  assert.equal(first.weak, false)
  assert.deepEqual(first.targetPositionPct, { min: 50, max: 70 })
})

test('军师扁平市场字段和组合嵌套字段使用同一评分口径', () => {
  const nested = deriveMarketRegime(strongMarket)
  const flat = deriveMarketRegime({
    indices: strongMarket.indices,
    ...strongMarket.breadth,
    updatedAt: strongMarket.updatedAt,
  })
  const portfolio = derivePortfolioMarketContext(strongMarket)

  assert.equal(flat.score, nested.score)
  assert.equal(flat.regime, nested.regime)
  assert.equal(portfolio.score, nested.score)
  assert.equal(portfolio.regimeCode, nested.regime)
  assert.equal(portfolio.regime, nested.portfolioRegime)
})

test('关键市场证据缺失时明确输出UNKNOWN并禁止新增风险', () => {
  const result = deriveMarketRegime({})

  assert.equal(result.regime, 'UNKNOWN')
  assert.equal(result.dataQuality, 'MISSING')
  assert.equal(result.allowRiskIncrease, false)
  assert.equal(result.score, null)
  assert.deepEqual(result.targetPositionPct, { min: 0, max: 0 })
})

test('指数和涨跌家数胶着时识别为震荡而不是强行趋势化', () => {
  const result = deriveMarketRegime({
    indices: [
      { name: '上证指数', pct: 0.08 },
      { name: '深证成指', pct: -0.12 },
    ],
    breadth: {
      up: 2480,
      down: 2420,
      flat: 100,
      limitUp: 38,
      limitDown: 31,
      volLevel: '平量',
    },
  })

  assert.equal(result.regime, 'RANGE')
  assert.equal(result.portfolioRegime, 'balanced')
  assert.deepEqual(result.targetPositionPct, { min: 30, max: 50 })
})
