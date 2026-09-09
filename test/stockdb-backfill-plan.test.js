import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMinuteExportManifest,
  selectCausalUniverse,
  selectReplayDates,
} from '../scripts/lib/stockdb-backfill-plan.mjs'

test('回放日期保留历史窗口和未来结算窗口', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    date: `202601${String(index + 1).padStart(2, '0')}`,
  }))
  const result = selectReplayDates(rows, {
    historyDays: 5,
    signalDays: 8,
    settlementDays: 3,
  })

  assert.equal(result.historyDates.length, 5)
  assert.equal(result.signalDates.length, 8)
  assert.equal(result.processingDates.length, 11)
  assert.equal(result.signalDates.at(-1), '20260117')
})

test('历史股票池只使用信号日前已完成日线', () => {
  const dailyByCode = new Map([
    ['600001', [
      {
        date: '20260907',
        code: '600001',
        close: 10,
        amount: 40_000_000,
        turnover: 1,
      },
      {
        date: '20260908',
        code: '600001',
        close: 20,
        amount: 9_000_000_000,
        turnover: 20,
      },
    ]],
    ['600002', [{
      date: '20260907',
      code: '600002',
      close: 10,
      amount: 80_000_000,
      turnover: 1,
    }]],
  ])

  assert.deepEqual(
    selectCausalUniverse(dailyByCode, '20260908', {
      limit: 100,
      liquidShare: 1,
    }),
    ['600001', '600002'],
  )
})

test('分钟导出清单保留历史候选的未来结果路径', () => {
  const dates = [
    '20260901',
    '20260902',
    '20260903',
    '20260904',
  ]
  const manifest = buildMinuteExportManifest({
    processingDates: dates,
    signalDates: dates.slice(0, 2),
    holdingSessions: 2,
    universesByDate: new Map([
      ['20260901', ['600001']],
      ['20260902', ['600002']],
    ]),
  })

  assert.deepEqual(manifest.dates, [
    { date: '20260901', codes: ['600001'] },
    { date: '20260902', codes: ['600001', '600002'] },
    { date: '20260903', codes: ['600001', '600002'] },
    { date: '20260904', codes: ['600002'] },
  ])
})
