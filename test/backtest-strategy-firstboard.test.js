import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isHighQualityFirstBoard,
  generateFirstBoardSignals,
} from '../shared/backtest/strategies/firstBoardBreakout.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'

function board(overrides = {}) {
  return {
    date: '20260110', code: '600000.SH', name: '测试', industry: '半导体',
    limitType: 'U', limitTimes: 1, openTimes: 0,
    fdAmount: 2e8, floatMv: 2e10, // 封单/流通 = 1%，流通200亿(元)
    firstTime: '94500', close: 11,
    ...overrides,
  }
}

test('高质量首板：首板+封得实+非尾盘+市值达标', () => {
  assert.equal(isHighQualityFirstBoard(board()), true)
})

test('5位首封时间(如93203)补零后正确判定为早盘', () => {
  // "93203"→"093203"=09:32:03，早于14:00阈值，不应被误拒
  assert.equal(isHighQualityFirstBoard(board({ firstTime: '93203' })), true)
})

test('非首板(连板)被排除', () => {
  assert.equal(isHighQualityFirstBoard(board({ limitTimes: 3 })), false)
})

test('炸板/跌停被排除', () => {
  assert.equal(isHighQualityFirstBoard(board({ limitType: 'Z' })), false)
  assert.equal(isHighQualityFirstBoard(board({ limitType: 'D' })), false)
})

test('尾盘偷袭板(首封晚于阈值)被排除', () => {
  assert.equal(
    isHighQualityFirstBoard(board({ firstTime: '145500' })),
    false,
  )
})

test('封单太薄(封单额/流通市值过低)被排除', () => {
  assert.equal(
    isHighQualityFirstBoard(board({ fdAmount: 2e10 * 0.001 })),
    false,
  )
})

test('首板次日开盘产生买入信号并可回测', () => {
  const limitRecords = [board({ date: '20260110' })]
  const bars = [
    { date: '20260110', open: 10.5, high: 11, low: 10.4, close: 11, volume: 1e6 }, // 首板日
    { date: '20260111', open: 11.3, high: 12.2, low: 11.1, close: 12.0, volume: 1.5e6 }, // 次日成交
    { date: '20260112', open: 12.0, high: 12.5, low: 11.8, close: 12.3, volume: 1e6 },
    { date: '20260113', open: 12.3, high: 12.4, low: 11.5, close: 11.6, volume: 1e6 },
  ]
  const signals = generateFirstBoardSignals(limitRecords, bars)
  const buy = signals.find((s) => s.side === 'BUY')
  assert.ok(buy, '应在首板次日产生买入信号')
  assert.equal(buy.date, '20260111')
  assert.ok(buy.plan.entryTriggerPrice > 0)
  assert.equal(buy.plan.entryWindow, '首板次日开盘')

  const result = runSingleAssetBacktest({
    security: { code: '600000.SH' }, bars, signals,
  })
  assert.ok(typeof result.trades.length === 'number')
})
