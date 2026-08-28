import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMins } from '../backtest/data/minuteData.js'

test('normalizeMins 拆分trade_time为date/time并升序', () => {
  // 代理返回降序，归一化应转升序
  const rows = normalizeMins([
    { trade_time: '2026-01-05 15:00:00', open: 11.83, high: 11.83, low: 11.81, close: 11.82, vol: 3078700, amount: 36378746 },
    { trade_time: '2026-01-05 09:35:00', open: 12.47, high: 12.48, low: 12.26, close: 12.36, vol: 5246600, amount: 64830969 },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].time, '0935') // 升序：早盘在前
  assert.equal(rows[0].date, '20260105')
  assert.equal(rows[1].time, '1500')
  assert.equal(rows[0].close, 12.36)
})

test('normalizeMins 过滤缺失价/非法时间', () => {
  const rows = normalizeMins([
    { trade_time: 'bad', open: 1, close: 1 },
    { trade_time: '2026-01-05 09:35:00', open: null, close: null },
    { trade_time: '2026-01-05 10:00:00', open: 10, high: 10.1, low: 9.9, close: 10.05, vol: 1, amount: 1 },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].time, '1000')
})

test('normalizeMins 跨日也正确排序', () => {
  const rows = normalizeMins([
    { trade_time: '2026-01-06 09:35:00', open: 1, high: 1, low: 1, close: 1, vol: 1, amount: 1 },
    { trade_time: '2026-01-05 14:55:00', open: 1, high: 1, low: 1, close: 1, vol: 1, amount: 1 },
  ])
  assert.equal(rows[0].date, '20260105')
  assert.equal(rows[1].date, '20260106')
})
