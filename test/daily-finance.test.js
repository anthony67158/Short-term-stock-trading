import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeDailyAttribution,
  computeDailyFinance,
  computeTodayOperationPnl,
  todayTradeCodes,
} from '../shared/dailyFinance.js'

const at = (text) => new Date(`${text}+08:00`).getTime()

test('今日买卖现金流按含费实际支出和净入账计算', () => {
  const result = computeDailyFinance({
    now: at('2026-08-10T10:30:00'),
    holdings: [{ code: '000001', qty: 1, buyPrice: 10, buyFee: 5 }],
    trades: [
      { type: 'BUY', code: '000001', qty: 1, price: 11, amount: 1100, fee: 5, at: at('2026-08-10T09:40:00') },
      { type: 'SELL', code: '000002', qty: 2, price: 8, amount: 1600, fee: 6, at: at('2026-08-10T10:00:00') },
    ],
    quoteMap: { '000001': { price: 12, prevClose: 11, tradeDate: '2026-08-10' } },
  })

  assert.equal(result.buyOutflow, 1105)
  assert.equal(result.sellInflow, 1594)
  assert.equal(result.buyCount, 1)
  assert.equal(result.sellCount, 1)
  assert.equal(result.netCashFlow, 489)
})

test('今日操作盈亏只汇总已实现的减仓清仓和做T净收益', () => {
  const result = computeTodayOperationPnl({
    now: at('2026-08-10T14:00:00'),
    holdings: [],
    trades: [
      {
        type: 'SELL',
        tradeIntent: 'position',
        code: '000001',
        qty: 1,
        realizedPnl: 300,
        at: at('2026-08-10T10:00:00'),
      },
      {
        type: 'T',
        code: '000002',
        qty: 1,
        netPnl: 147,
        at: at('2026-08-10T11:00:00'),
      },
      {
        type: 'BUY',
        code: '000003',
        qty: 1,
        at: at('2026-08-10T09:40:00'),
      },
      {
        type: 'SELL',
        tradeIntent: 'position',
        code: '000004',
        qty: 1,
        realizedPnl: 999,
        at: at('2026-08-07T10:00:00'),
      },
    ],
  })

  assert.deepEqual(result, {
    total: 447,
    positionPnl: 300,
    tPnl: 147,
    positionCount: 1,
    tCount: 1,
    realizedCount: 2,
  })
})

test('今日操作盈亏纳入已配对但尚未结算的做T流水', () => {
  const result = computeTodayOperationPnl({
    now: at('2026-08-10T14:00:00'),
    holdings: [{
      code: '600000',
      tFlows: [
        {
          id: 'buy-today',
          side: 'buy',
          price: 10,
          qty: 1,
          fee: 5,
          at: at('2026-08-10T10:00:00'),
        },
        {
          id: 'sell-today',
          side: 'sell',
          price: 11,
          qty: 1,
          fee: 6,
          at: at('2026-08-10T11:00:00'),
        },
        {
          id: 'open-buy',
          side: 'buy',
          price: 9.8,
          qty: 1,
          fee: 5,
          at: at('2026-08-10T13:00:00'),
        },
      ],
    }],
    trades: [],
  })

  assert.equal(result.total, 89)
  assert.equal(result.positionPnl, 0)
  assert.equal(result.tPnl, 89)
  assert.equal(result.tCount, 1)
  assert.equal(result.realizedCount, 1)
})

test('今日操作盈亏按手动选择的做T配对计算差价且不重复计算卖出盈亏', () => {
  const result = computeTodayOperationPnl({
    now: at('2026-08-10T14:00:00'),
    holdings: [],
    trades: [
      {
        id: 'manual-buy',
        type: 'BUY',
        tradeIntent: 't',
        tPairId: 'pair-1',
        code: '600000',
        qty: 1,
        price: 10,
        fee: 5,
        at: at('2026-08-10T10:00:00'),
      },
      {
        id: 'manual-sell',
        type: 'SELL',
        tradeIntent: 't',
        tPairId: 'pair-1',
        code: '600000',
        qty: 1,
        price: 11,
        fee: 6,
        realizedPnl: 480,
        at: at('2026-08-10T11:00:00'),
      },
    ],
  })

  assert.equal(result.total, 89)
  assert.equal(result.positionPnl, 0)
  assert.equal(result.tPnl, 89)
  assert.equal(result.tCount, 1)
})

test('较前收收益按持仓市值和当日现金流还原前收资产', () => {
  const result = computeDailyFinance({
    now: at('2026-08-10T14:00:00'),
    holdings: [{ code: '000001', qty: 1, buyPrice: 10, buyFee: 5 }],
    trades: [
      { type: 'BUY', code: '000001', qty: 1, price: 11, amount: 1100, fee: 5, at: at('2026-08-10T09:40:00') },
    ],
    quoteMap: { '000001': { price: 12, prevClose: 11, tradeDate: '2026-08-10' } },
  })

  // 昨日无持仓，今日买入后市值1200，扣实际支出1105，当日收益95。
  assert.equal(result.previousCloseValue, 0)
  assert.equal(result.dayChangeAmount, 95)
  assert.equal(result.dayChangePct, null)
  assert.equal(result.floatPnl, 195)
})

test('隔夜持仓按昨收市值计算当日涨跌金额与百分比', () => {
  const result = computeDailyFinance({
    now: at('2026-08-10T14:00:00'),
    holdings: [{ code: '600000', qty: 2, buyPrice: 9, buyFee: 5 }],
    trades: [],
    quoteMap: { '600000': { price: 10.5, prevClose: 10, tradeDate: '2026-08-10' } },
  })

  assert.equal(result.previousCloseValue, 2000)
  assert.equal(result.dayChangeAmount, 100)
  assert.equal(result.dayChangePct, 5)
  assert.equal(result.floatPnl, 295)
})

test('周末休市和交易日盘前不把旧行情显示成今日涨跌', () => {
  const base = {
    holdings: [{ code: '600000', qty: 1, buyPrice: 9, buyFee: 5 }],
    trades: [],
    quoteMap: { '600000': { price: 10.5, prevClose: 10, tradeDate: '2026-08-07' } },
  }
  const holiday = computeDailyFinance({ ...base, now: at('2026-08-09T14:00:00') })
  const preopen = computeDailyFinance({ ...base, now: at('2026-08-10T08:30:00') })

  assert.equal(holiday.marketStatus, 'closed')
  assert.equal(holiday.dayChangeAmount, null)
  assert.equal(preopen.marketStatus, 'preopen')
  assert.equal(preopen.dayChangeAmount, null)
})

test('今日已清仓股票仍加入行情查询以完成前收比较', () => {
  const codes = todayTradeCodes([
    { type: 'SELL', code: '000001', qty: 1, price: 10, at: at('2026-08-10T10:00:00') },
    { type: 'SELL', code: '000002', qty: 1, price: 10, at: at('2026-08-07T10:00:00') },
  ], [], at('2026-08-10T14:00:00'))

  assert.deepEqual(codes, ['000001'])
})

test('盘中行情日期不是今天时拒绝计算较前收', () => {
  const result = computeDailyFinance({
    now: at('2026-08-10T10:30:00'),
    holdings: [{ code: '600000', qty: 1, buyPrice: 9, buyFee: 5 }],
    trades: [],
    quoteMap: { '600000': { price: 10.5, prevClose: 10, tradeDate: '2026-08-07' } },
  })

  assert.equal(result.marketStatus, 'active')
  assert.equal(result.dayChangeAmount, null)
})

test('当日损益归因区分隔夜持仓、今日新买和卖出执行', () => {
  const result = computeDailyAttribution({
    now: at('2026-08-10T15:10:00'),
    holdings: [
      { code: '600000', name: '隔夜股', qty: 2, buyPrice: 9, buyFee: 5 },
      { code: '000001', name: '新买股', qty: 1, buyPrice: 11, buyFee: 5 },
    ],
    trades: [
      { type: 'BUY', code: '000001', name: '新买股', qty: 1, price: 11, fee: 5, at: at('2026-08-10T10:00:00') },
      { type: 'SELL', code: '000002', name: '卖出股', qty: 1, price: 9.5, fee: 5, at: at('2026-08-10T11:00:00') },
    ],
    quoteMap: {
      '600000': { price: 9.5, prevClose: 10, tradeDate: '2026-08-10' },
      '000001': { price: 10.5, prevClose: 10.8, tradeDate: '2026-08-10' },
      '000002': { price: 9, prevClose: 10, tradeDate: '2026-08-10' },
    },
  })

  assert.equal(result.overnightPnl, -100)
  assert.equal(result.newBuyPnl, -55)
  assert.equal(result.sellExecutionPnl, -55)
  assert.equal(result.total, -210)
  assert.deepEqual(result.topLosses.map((item) => item.name), [
    '隔夜股',
    '新买股',
    '卖出股',
  ])
})
