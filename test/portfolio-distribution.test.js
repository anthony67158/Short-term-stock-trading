import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPortfolioDistribution,
  portfolioCategory,
} from '../shared/portfolioDistribution.js'

const portfolio = {
  totalAssets: 100000,
  holdMktValue: 70000,
  available: 30000,
  positions: [
    {
      id: 'h1',
      code: '600111',
      name: '北方稀土',
      qty: 2,
      price: 25,
      mktValue: 5000,
      costValue: 4200,
      floatPnl: 800,
      floatPct: 19.05,
      weight: 5,
    },
    {
      id: 'h2',
      code: '600111',
      name: '北方稀土',
      qty: 3,
      price: 25,
      mktValue: 7500,
      costValue: 6900,
      floatPnl: 600,
      floatPct: 8.7,
      weight: 7.5,
    },
    {
      id: 'h3',
      code: '300476',
      name: '胜宏科技',
      qty: 5,
      price: 100,
      mktValue: 50000,
      costValue: 46000,
      floatPnl: 4000,
      floatPct: 8.7,
      weight: 50,
    },
    {
      id: 'h4',
      code: '000001',
      name: '平安银行',
      qty: 5,
      price: 15,
      mktValue: 7500,
      costValue: 8000,
      floatPnl: -500,
      floatPct: -6.25,
      weight: 7.5,
    },
  ],
}

const tagMap = {
  '600111': { primaryTopic: '稀土永磁', industry: '小金属' },
  '300476': { primaryTopic: 'PCB', industry: '元件' },
  '000001': { primaryTopic: '跨境支付', industry: '银行' },
}

const quoteMap = {
  '600111': { price: 25, prevClose: 24.5, pct: 2.04 },
  '300476': { price: 100, prevClose: 102, pct: -1.96 },
  '000001': { price: 15, prevClose: 15, pct: 0 },
}

test('持仓分布按核心概念分组并合并同股多笔持仓', () => {
  const result = buildPortfolioDistribution(portfolio, tagMap)

  assert.equal(result.totalAssets, 100000)
  assert.equal(result.investedValue, 70000)
  assert.equal(result.cashReservePct, 30)
  assert.equal(result.stocks.length, 3)
  assert.deepEqual(
    result.groups.map((group) => ({
      name: group.name,
      marketValue: group.marketValue,
      accountWeightPct: group.accountWeightPct,
    })),
    [
      { name: 'PCB', marketValue: 50000, accountWeightPct: 50 },
      { name: '稀土永磁', marketValue: 12500, accountWeightPct: 12.5 },
      { name: '跨境支付', marketValue: 7500, accountWeightPct: 7.5 },
    ],
  )
  assert.deepEqual(
    result.groups[1].children[0],
    {
      code: '600111',
      name: '北方稀土',
      concept: '稀土永磁',
      industry: '小金属',
      qty: 5,
      price: 25,
      marketValue: 12500,
      costValue: 11100,
      floatPnl: 1400,
      floatPct: 12.61,
      dayPct: null,
      dayPnl: null,
      accountWeightPct: 12.5,
      holdingWeightPct: 17.86,
      category: '标准仓',
    },
  )
})

test('仓位类别按总资产占比分为核心仓、标准仓与卫星仓', () => {
  assert.equal(portfolioCategory(20), '核心仓')
  assert.equal(portfolioCategory(10), '标准仓')
  assert.equal(portfolioCategory(3), '卫星仓')
})

test('热力图面积保留仓位口径，颜色数据使用当日红涨绿跌', () => {
  const result = buildPortfolioDistribution(
    portfolio,
    tagMap,
    {},
    quoteMap,
  )
  const rareEarth = result.stocks.find((item) => item.code === '600111')
  const pcb = result.stocks.find((item) => item.code === '300476')
  const bank = result.stocks.find((item) => item.code === '000001')

  assert.equal(rareEarth.accountWeightPct, 12.5)
  assert.equal(rareEarth.dayPct, 2.04)
  assert.equal(rareEarth.dayPnl, 250)
  assert.equal(pcb.dayPct, -1.96)
  assert.equal(pcb.dayPnl, -1000)
  assert.equal(bank.dayPct, 0)
  assert.equal(bank.dayPnl, 0)
  assert.equal(result.dayPnl, -750)
  assert.equal(result.dayPct, -1.06)
  assert.equal(result.groups.find((group) => group.name === '稀土永磁').dayPct, 2.04)
  assert.equal(result.groups.find((group) => group.name === 'PCB').dayPct, -1.96)
  assert.ok(result.stocks.every((item) => !('intensity' in item)))
})

test('持仓分布保留服务端T+1可卖与锁定手数', () => {
  const result = buildPortfolioDistribution(portfolio, tagMap, {
    '300476': {
      sellableQty: 2,
      boughtTodayQty: 1,
    },
  })
  const stock = result.stocks.find((item) => item.code === '300476')

  assert.equal(stock.sellableQty, 2)
  assert.equal(stock.boughtTodayQty, 1)
  assert.equal(stock.t1Locked, true)
})
