import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hotSeatNetBuyWan,
  generateLhbFollowSignals,
  LHB_FOLLOW_DEFAULTS,
  DEFAULT_HOT_SEATS,
} from '../shared/backtest/strategies/lhbInstFollow.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'

test('hotSeatNetBuyWan 只累计热钱/机构席位净买入并转万元', () => {
  const recs = [
    { seat: '东方财富证券股份有限公司拉萨东环路第二证券营业部', netBuy: 30_000_000 },
    { seat: '机构专用', netBuy: 20_000_000 },
    { seat: '某普通营业部', netBuy: 50_000_000 }, // 非热钱→不计
  ]
  const { netWan, seatHits } = hotSeatNetBuyWan(recs)
  assert.equal(seatHits, 2)
  assert.equal(netWan, 5000) // (3e7+2e7)/1e4
})

test('热钱席位净买入达标时次日开盘产生跟随买入', () => {
  const instByDate = {
    '20260114': [
      { seat: '中信建投证券股份有限公司北京马连洼北路证券营业部', netBuy: 40_000_000 },
    ],
  }
  const bars = [
    { date: '20260114', open: 10, high: 11, low: 9.9, close: 11, volume: 1e6 },
    { date: '20260115', open: 11.2, high: 12.5, low: 11.0, close: 12.3, volume: 1.4e6 },
    { date: '20260116', open: 12.3, high: 12.8, low: 12.0, close: 12.6, volume: 1e6 },
  ]
  const signals = generateLhbFollowSignals(instByDate, bars, { minSeatNetBuyWan: 2000 })
  const buy = signals.find((s) => s.side === 'BUY')
  assert.ok(buy, '热钱净买达标应产生买入')
  assert.equal(buy.date, '20260115')
  assert.match(buy.reason, /热钱席位净买/)
  assert.equal(buy.plan.entryWindow, '龙虎榜次日开盘')

  const result = runSingleAssetBacktest({ security: { code: '600000.SH' }, bars, signals })
  assert.ok(typeof result.trades.length === 'number')
})

test('净买入低于阈值不产生信号', () => {
  const instByDate = {
    '20260114': [{ seat: '机构专用', netBuy: 1_000_000 }], // 100万 < 2000万阈值
  }
  const bars = [
    { date: '20260114', open: 10, high: 11, low: 9.9, close: 11, volume: 1e6 },
    { date: '20260115', open: 11, high: 11.5, low: 10.8, close: 11.2, volume: 1e6 },
  ]
  const signals = generateLhbFollowSignals(instByDate, bars)
  assert.equal(signals.filter((s) => s.side === 'BUY').length, 0)
})

test('占成交额比例过低时被过滤', () => {
  const instByDate = {
    '20260114': [{ seat: '机构专用', netBuy: 30_000_000 }], // 3000万
  }
  const bars = [
    { date: '20260114', open: 10, high: 11, low: 9.9, close: 11, volume: 1e6 },
    { date: '20260115', open: 11, high: 11.5, low: 10.8, close: 11.2, volume: 1e6 },
  ]
  // 当日成交额100亿 → 3000万占比仅0.3% < 3%阈值
  const signals = generateLhbFollowSignals(instByDate, bars, {}, {
    amountByDate: { '20260114': 1e10 },
  })
  assert.equal(signals.filter((s) => s.side === 'BUY').length, 0)
})

test('默认热钱名单与参数暴露', () => {
  assert.ok(DEFAULT_HOT_SEATS.includes('机构专用'))
  assert.equal(LHB_FOLLOW_DEFAULTS.maxHoldDays, 3)
})
