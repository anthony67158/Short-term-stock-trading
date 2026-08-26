import test from 'node:test'
import assert from 'node:assert/strict'

import {
  backfillDailyCandlesFromMinuteBars,
  quantInputReadiness,
  selectFreshestDailyDetail,
} from '../shared/advisorQuantInput.js'

function candles(lastDate, count = 30) {
  const rows = Array.from({ length: count }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume: 1000,
    pct: 0,
  }))
  rows[rows.length - 1] = {
    ...rows.at(-1),
    date: lastDate,
    close: 10.5,
  }
  return rows
}

test('盘后在主源与备用源之间选择包含当天收盘的最新完整日K', () => {
  const selected = selectFreshestDailyDetail(
    {
      ok: true,
      profile: { name: '测试股票' },
      candles: candles('2026-08-25'),
      tech: { source: 'primary' },
    },
    {
      name: '测试股票',
      candles: candles('2026-08-26'),
    },
    {
      computeTechnicals: (rows) => ({
        source: 'recomputed',
        asOf: rows.at(-1).date,
      }),
    },
  )

  assert.equal(selected.candles.at(-1).date, '2026-08-26')
  assert.equal(selected.profile.name, '测试股票')
  assert.deepEqual(selected.tech, {
    source: 'recomputed',
    asOf: '2026-08-26',
  })
})

test('量化输入闸门按所选模型的数据口径判断', () => {
  assert.deepEqual(
    quantInputReadiness('default', candles('2026-08-26', 24)),
    {
      ready: false,
      source: 'daily',
      reason: 'INSUFFICIENT_DAILY_CANDLES',
    },
  )
  assert.deepEqual(
    quantInputReadiness(
      'default',
      [],
      { allowMinuteBackfill: true },
    ),
    {
      ready: true,
      source: 'minute-backfill',
      reason: '',
    },
  )
  assert.deepEqual(
    quantInputReadiness('default', candles('2026-08-26', 25)),
    {
      ready: true,
      source: 'daily',
      reason: '',
    },
  )
  assert.deepEqual(
    quantInputReadiness('v2', []),
    {
      ready: true,
      source: 'minute',
      reason: '',
    },
  )
  assert.deepEqual(
    quantInputReadiness('v2.1', []),
    {
      ready: true,
      source: 'minute',
      reason: '',
    },
  )
})

test('日K双源失败时用最近25个交易日的5分钟K恢复默认模型输入', () => {
  const bars = []
  for (let day = 1; day <= 25; day++) {
    const date = `2026-08-${String(day).padStart(2, '0')}`
    for (let index = 0; index < 48; index++) {
      const morning = index < 24
      const total = morning
        ? 9 * 60 + 35 + index * 5
        : 13 * 60 + 5 + (index - 24) * 5
      const hh = String(Math.floor(total / 60)).padStart(2, '0')
      const mm = String(total % 60).padStart(2, '0')
      bars.push({
        tradeTime: `${date} ${hh}:${mm}:00`,
        open: 10,
        high: 10.2,
        low: 9.8,
        close: 10 + day / 100,
        volume: 1000,
      })
    }
  }

  const result = backfillDailyCandlesFromMinuteBars([], bars, {
    tradingToday: true,
    isLive: false,
    phase: '盘后(已收盘)',
    bjNow: '2026-08-25 15:30',
  })

  assert.equal(result.candles.length, 25)
  assert.equal(result.candles.at(-1).date, '2026-08-25')
  assert.equal(result.candles.at(-1).volume, 48000)
  assert.equal(result.inputAsOf, '2026-08-25 15:00:00')
  assert.equal(result.inputSource, 'completed-5m-daily-backfill')
  assert.equal(
    quantInputReadiness('default', result.candles).ready,
    true,
  )
})
