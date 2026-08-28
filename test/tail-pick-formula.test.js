import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateTailPickNearMatch,
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

test('接近公式只允许最多两个次要条件未通过', () => {
  const near = evaluateTailPickNearMatch({
    matched: false,
    failedRules: [
      { key: 'HSL', label: '换手率大于5%' },
      { key: 'AB4', label: '上影线形态' },
    ],
  }, {
    turnover: 4.2,
    amount: 100_000_000,
  })

  assert.equal(near.matched, true)
  assert.equal(near.matchRate, 85.7)
  assert.equal(near.passedCount, 12)
  assert.equal(near.totalRuleCount, 14)
  assert.deepEqual(
    near.failedRules.map((item) => item.key),
    ['HSL', 'AB4'],
  )

  const tooFar = evaluateTailPickNearMatch({
    matched: false,
    failedRules: [
      { key: 'AB4', label: '上影线形态' },
      { key: 'AB6', label: '前高约束' },
      { key: 'AB32', label: '成交量约束' },
    ],
  }, {
    turnover: 6,
    amount: 100_000_000,
  })
  assert.equal(tooFar.matched, false)
})

test('接近公式不放宽核心反转条件、基础流动性或严格命中', () => {
  const coreFailure = evaluateTailPickNearMatch({
    matched: false,
    failedRules: [
      { key: 'AB8', label: '昨日跌幅超过约3.29%' },
    ],
  }, {
    turnover: 6,
    amount: 100_000_000,
  })
  assert.equal(coreFailure.matched, false)
  assert.match(coreFailure.blockers.join('；'), /核心条件/)

  const lowTurnover = evaluateTailPickNearMatch({
    matched: false,
    failedRules: [
      { key: 'HSL', label: '换手率大于5%' },
    ],
  }, {
    turnover: 3.99,
    amount: 100_000_000,
  })
  assert.equal(lowTurnover.matched, false)

  const overheatedVolume = evaluateTailPickNearMatch({
    matched: false,
    failedRules: [
      { key: 'AB32', label: '当日成交量过热' },
    ],
  }, {
    turnover: 6,
    amount: 100_000_000,
  })
  assert.equal(overheatedVolume.matched, false)

  const strict = evaluateTailPickNearMatch({
    matched: true,
    failedRules: [],
  }, {
    turnover: 6,
    amount: 100_000_000,
  })
  assert.equal(strict.matched, false)
})
