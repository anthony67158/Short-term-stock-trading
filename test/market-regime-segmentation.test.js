import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MARKET_REGIMES,
  MARKET_REGIME_SEGMENTATION_VERSION,
  annualHoldoutSplit,
  segmentMarketRegime,
} from '../shared/marketRegimeSegmentation.js'

// 造一条指数序列：给定每日收盘，日期从 startYear-01-01 连续自增（仅测试用，
// 不要求真实交易日历）。
function series(closes, startDate = '20210101') {
  let y = Number(startDate.slice(0, 4))
  let m = Number(startDate.slice(4, 6))
  let d = Number(startDate.slice(6, 8))
  return closes.map((close) => {
    const date = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
    d += 1
    if (d > 28) { d = 1; m += 1 }
    if (m > 12) { m = 1; y += 1 }
    return { date, close }
  })
}

test('持续上行序列判为BULL占多数', () => {
  const rising = series(Array.from({ length: 120 }, (_, i) => 100 + i))
  const seg = segmentMarketRegime(rising)
  assert.equal(seg.schemaVersion, MARKET_REGIME_SEGMENTATION_VERSION)
  assert.ok(seg.counts.BULL > seg.counts.RETREAT)
  for (const d of seg.days) assert.ok(MARKET_REGIMES.includes(d.regime))
})

test('持续下行序列判为RETREAT占多数', () => {
  const falling = series(Array.from({ length: 120 }, (_, i) => 220 - i))
  const seg = segmentMarketRegime(falling)
  assert.ok(seg.counts.RETREAT > seg.counts.BULL)
})

test('窗口不足时归类为CHOP不报错', () => {
  const seg = segmentMarketRegime(series([100, 101, 102]))
  assert.equal(seg.coverage, 3)
  assert.equal(seg.days.every((d) => d.regime === 'CHOP'), true)
})

test('年度holdout取最后一个完整年', () => {
  // 2021、2022 各 210 天(完整)，2023 只 50 天(不完整)。
  const rows = [
    ...series(Array.from({ length: 210 }, () => 100), '20210101'),
    ...series(Array.from({ length: 210 }, () => 100), '20220101'),
    ...series(Array.from({ length: 50 }, () => 100), '20230101'),
  ]
  const split = annualHoldoutSplit(rows, { completeYearMinDays: 200 })
  assert.deepEqual(split.completeYears, ['2021', '2022'])
  assert.equal(split.holdoutYear, '2022')
  assert.deepEqual(split.tuningYears, ['2021'])
  assert.equal(split.provable, true)
})

test('完整年不足2个时不可给年度结论', () => {
  const rows = series(Array.from({ length: 210 }, () => 100), '20210101')
  const split = annualHoldoutSplit(rows, { completeYearMinDays: 200 })
  assert.equal(split.completeYears.length, 1)
  assert.equal(split.provable, false)
  assert.match(split.note, /不足2个/)
})

test('非法/重复行被清洗', () => {
  const seg = segmentMarketRegime([
    { date: '20210101', close: 100 },
    { date: '2021-01-01', close: 100 }, // 同日去重
    { date: 'bad', close: 100 },
    { date: '20210102', close: -5 },    // 非法价剔除
  ])
  assert.equal(seg.coverage, 1)
})
