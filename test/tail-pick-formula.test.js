import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateTailPickSignal,
  mergeTailPickCurrentBar,
  TAIL_PICK_FORMULA_VERSION,
} from '../shared/tailPickFormula.js'

function matchingCandles() {
  const rows = Array.from({ length: 31 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    open: 10,
    close: 10,
    high: 10.1,
    low: 9.9,
    volume: 1000,
    amount: 80_000_000,
  }))
  rows[27] = {
    ...rows[27],
    open: 10,
    close: 10.1,
    high: 10.2,
    low: 9.6,
  }
  rows[28] = {
    ...rows[28],
    open: 9.9,
    close: 10,
    high: 10.2,
    low: 9.6,
  }
  rows[29] = {
    ...rows[29],
    open: 9.8,
    close: 9.5,
    high: 9.95,
    low: 9.4,
  }
  rows[30] = {
    ...rows[30],
    open: 9.55,
    close: 9.82,
    high: 10,
    low: 9.5,
    volume: 2000,
    amount: 120_000_000,
  }
  return rows
}

test('尾盘拾金公式完整命中恢复后的14个有效条件', () => {
  const result = evaluateTailPickSignal({
    candles: matchingCandles(),
    turnover: 6,
  })

  assert.equal(result.matched, true)
  assert.equal(result.sourceVersion, TAIL_PICK_FORMULA_VERSION)
  assert.equal(result.failedRules.length, 0)
  assert.equal(result.signals.length, 14)
})

test('原源码未使用的涨幅上限不会被擅自加入公式', () => {
  const rows = matchingCandles()
  rows.at(-3).high = 10.8
  rows.at(-3).low = 10
  rows.at(-2).high = 10.5
  rows.at(-1).open = 9.8
  rows.at(-1).low = 9.78
  rows.at(-1).close = 10.45
  rows.at(-1).high = 10.6

  const result = evaluateTailPickSignal({
    candles: rows,
    turnover: 6,
  })

  assert.equal(result.matched, true)
})

test('换手不足和昨日跌幅不足均会阻止公式命中', () => {
  const turnoverFailure = evaluateTailPickSignal({
    candles: matchingCandles(),
    turnover: 4.99,
  })
  assert.equal(turnoverFailure.matched, false)
  assert.match(
    turnoverFailure.failedRules.map((item) => item.label).join('；'),
    /换手率/,
  )

  const rows = matchingCandles()
  rows.at(-2).close = 9.8
  const declineFailure = evaluateTailPickSignal({
    candles: rows,
    turnover: 6,
  })
  assert.equal(declineFailure.matched, false)
  assert.match(
    declineFailure.failedRules.map((item) => item.label).join('；'),
    /昨日较前日下跌/,
  )
})

test('实时行情只替换同交易日K线而不重复追加', () => {
  const rows = matchingCandles()
  const merged = mergeTailPickCurrentBar(rows, {
    tradeDate: rows.at(-1).date,
    open: 9.55,
    price: 9.9,
    high: 10,
    low: 9.5,
    volume: 2100,
    amount: 130_000_000,
  })

  assert.equal(merged.length, rows.length)
  assert.equal(merged.at(-1).close, 9.9)
  assert.equal(merged.at(-1).volume, 2100)
})
