import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  replayAlpha158Account,
} from '../backtest/decision/replay-alpha158.mjs'
import {
  loadDecisionDailyRows,
} from '../backtest/decision/replay-review-v3.mjs'

function bar(code, date, close, previousClose = close) {
  return {
    date,
    code,
    name: code,
    open: close,
    high: close,
    low: close,
    close,
    previousClose,
    volume: 100000,
  }
}

test('Alpha158 Topk-Drop使用同一账户撮合并保持账本一致', () => {
  const dates = ['20260101', '20260102', '20260105']
  const rows = [
    bar('600001', '20260101', 10, 9.9),
    bar('600002', '20260101', 10, 9.9),
    bar('600003', '20260101', 10, 9.9),
    bar('600001', '20260102', 10, 10),
    bar('600002', '20260102', 10, 10),
    bar('600003', '20260102', 10, 10),
    bar('600001', '20260105', 11, 10),
    bar('600002', '20260105', 9.5, 10),
    bar('600003', '20260105', 10.5, 10),
  ]
  const byDate = new Map()
  const byCode = new Map()
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, new Map())
    byDate.get(row.date).set(row.code, row)
    if (!byCode.has(row.code)) byCode.set(row.code, new Map())
    byCode.get(row.code).set(row.date, row)
  }
  const rankings = [
    { date: '20260101', code: '600001', rank: 1, score: 3 },
    { date: '20260101', code: '600002', rank: 2, score: 2 },
    { date: '20260102', code: '600001', rank: 1, score: 3 },
    { date: '20260102', code: '600003', rank: 2, score: 2 },
    { date: '20260102', code: '600002', rank: 3, score: 1 },
  ]

  const result = replayAlpha158Account({
    rankings,
    daily: { byDate, byCode },
    dates,
    topk: 2,
    nDrop: 1,
  })

  assert.equal(result.summary.audit.ok, true)
  assert.equal(result.summary.closedTradeCount, 1)
  assert.ok(result.accountState.positions['600001'])
  assert.ok(result.accountState.positions['600003'])
  assert.equal(result.accountState.positions['600002'], undefined)
})

test('Alpha158行情加载按preClose消除除权价格断点', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'alpha158-adjusted-'),
  )
  const file = path.join(directory, 'daily.json.gz')
  fs.writeFileSync(file, gzipSync(JSON.stringify([
    {
      date: '20260101',
      code: '600001',
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      preClose: 99,
      volume: 100000,
    },
    {
      date: '20260102',
      code: '600001',
      open: 50,
      high: 51,
      low: 49,
      close: 50,
      preClose: 50,
      volume: 100000,
    },
  ])))

  const daily = loadDecisionDailyRows(
    file,
    new Set(['600001']),
    { adjustPrices: true },
  )

  assert.equal(
    daily.byCode.get('600001').get('20260102').close,
    100,
  )
  fs.rmSync(directory, { recursive: true, force: true })
})
