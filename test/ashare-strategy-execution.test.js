import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assessAshareExecution,
  ashareLimitPrices,
  executionPrice,
  tradeFees,
} from '../shared/ashareStrategyExecution.js'

test('A股涨跌停价格沿用主板创业板科创板北交所与当前ST口径', () => {
  assert.deepEqual(
    ashareLimitPrices({ code: '600001', name: '主板' }, 10),
    {
      lower: 9,
      upper: 11,
      ratio: 0.1,
      ruleVersion: 'CN_A_SHARE_2026_07_06',
    },
  )
  assert.deepEqual(
    ashareLimitPrices({ code: '300001', name: '创业板' }, 10),
    {
      lower: 8,
      upper: 12,
      ratio: 0.2,
      ruleVersion: 'CN_A_SHARE_2026_07_06',
    },
  )
  assert.deepEqual(
    ashareLimitPrices({ code: '920001', name: '北交所' }, 10),
    {
      lower: 7,
      upper: 13,
      ratio: 0.3,
      ruleVersion: 'CN_A_SHARE_2026_07_06',
    },
  )
  assert.deepEqual(
    ashareLimitPrices({ code: '600001', name: '*ST样本' }, 10),
    {
      lower: 9,
      upper: 11,
      ratio: 0.1,
      ruleVersion: 'CN_A_SHARE_2026_07_06',
    },
  )
})

test('主板风险警示股历史回测按2026年7月6日切换涨跌停制度', () => {
  assert.deepEqual(
    ashareLimitPrices(
      { code: '600001', name: '*ST样本' },
      10,
      '2026-07-03',
    ),
    {
      lower: 9.5,
      upper: 10.5,
      ratio: 0.05,
      ruleVersion: 'CN_A_SHARE_2020_08_24',
    },
  )
  assert.deepEqual(
    ashareLimitPrices(
      { code: '600001', name: '*ST样本' },
      10,
      '2026-07-06',
    ),
    {
      lower: 9,
      upper: 11,
      ratio: 0.1,
      ruleVersion: 'CN_A_SHARE_2026_07_06',
    },
  )
})

test('创业板历史回测按2020年8月24日切换涨跌停制度', () => {
  assert.deepEqual(
    ashareLimitPrices(
      { code: '300001', name: '创业板' },
      10,
      '2020-08-21',
    ),
    {
      lower: 9,
      upper: 11,
      ratio: 0.1,
      ruleVersion: 'CN_A_SHARE_LEGACY',
    },
  )
  assert.deepEqual(
    ashareLimitPrices(
      { code: '300001', name: '创业板' },
      10,
      '2020-08-24',
    ),
    {
      lower: 8,
      upper: 12,
      ratio: 0.2,
      ruleVersion: 'CN_A_SHARE_2020_08_24',
    },
  )
})

test('一字涨停买入和一字跌停卖出不可成交且停牌也不可成交', () => {
  const buy = assessAshareExecution({
    side: 'BUY',
    security: { code: '600001', name: '主板' },
    tradeDate: '2026-08-14',
    previousClose: 10,
    openPrice: 11,
    volume: 1000,
    quantity: 100,
  })
  const sell = assessAshareExecution({
    side: 'SELL',
    security: { code: '600001', name: '主板' },
    tradeDate: '2026-08-14',
    acquiredDate: '2026-08-13',
    previousClose: 10,
    openPrice: 9,
    volume: 1000,
    quantity: 100,
  })
  const suspended = assessAshareExecution({
    side: 'BUY',
    security: { code: '600001', name: '主板' },
    tradeDate: '2026-08-14',
    previousClose: 10,
    openPrice: 10,
    volume: 0,
    quantity: 100,
  })

  assert.equal(buy.reason, 'LIMIT_UP_UNFILLED')
  assert.equal(sell.reason, 'LIMIT_DOWN_UNFILLED')
  assert.equal(suspended.reason, 'SUSPENDED_OR_NO_LIQUIDITY')
})

test('买入必须整手且卖出遵守T+1', () => {
  const oddBuy = assessAshareExecution({
    side: 'BUY',
    security: { code: '600001' },
    tradeDate: '2026-08-14',
    previousClose: 10,
    openPrice: 10,
    volume: 1000,
    quantity: 150,
  })
  const sameDaySell = assessAshareExecution({
    side: 'SELL',
    security: { code: '600001' },
    tradeDate: '2026-08-14',
    acquiredDate: '2026-08-14',
    previousClose: 10,
    openPrice: 10,
    volume: 1000,
    quantity: 100,
  })

  assert.equal(oddBuy.reason, 'INVALID_BUY_LOT')
  assert.equal(sameDaySell.reason, 'T_PLUS_ONE_LOCKED')
})

test('成交价计入方向性滑点且费用与实盘账本口径一致', () => {
  assert.equal(executionPrice(10, 'BUY', 5), 10.005)
  assert.equal(executionPrice(10, 'SELL', 5), 9.995)
  assert.deepEqual(tradeFees('BUY', 1000), {
    commission: 5,
    stampDuty: 0,
    transfer: 0.01,
    total: 5.01,
  })
  assert.deepEqual(tradeFees('SELL', 1000), {
    commission: 5,
    stampDuty: 0.5,
    transfer: 0.01,
    total: 5.51,
  })
})

test('正常成交返回含滑点价格、费用与现金流', () => {
  const result = assessAshareExecution({
    side: 'BUY',
    security: { code: '600001', name: '主板' },
    tradeDate: '2026-08-14',
    previousClose: 10,
    openPrice: 10,
    volume: 100000,
    quantity: 200,
    slippageBps: 5,
  })

  assert.equal(result.fillable, true)
  assert.equal(result.fillPrice, 10.005)
  assert.equal(result.grossAmount, 2001)
  assert.equal(result.fees.total, 5.02)
  assert.equal(result.cashFlow, -2006.02)
  assert.equal(result.ruleVersion, 'CN_A_SHARE_2026_07_06')
})
