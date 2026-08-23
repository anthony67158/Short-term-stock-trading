import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { tradingPollingIntervals } from '../shared/pollingPolicy.js'

const appSource = readFileSync(
  new URL('../src/App.jsx', import.meta.url),
  'utf8',
)
const alertStoreSource = readFileSync(
  new URL('../src/alertStore.js', import.meta.url),
  'utf8',
)

test('开盘前十五分钟使用10秒大盘与5秒预警轮询', () => {
  const opening = Date.parse('2026-08-24T01:35:00Z')

  assert.deepEqual(tradingPollingIntervals(opening), {
    trading: true,
    openingBurst: true,
    marketMs: 10_000,
    alertMs: 5_000,
  })
})

test('开盘十五分钟后恢复20秒大盘与10秒预警轮询', () => {
  const afterOpening = Date.parse('2026-08-24T01:45:00Z')

  assert.deepEqual(tradingPollingIntervals(afterOpening), {
    trading: true,
    openingBurst: false,
    marketMs: 20_000,
    alertMs: 10_000,
  })
})

test('非连续竞价时段保持低频轮询', () => {
  const lunchBreak = Date.parse('2026-08-24T04:00:00Z')

  assert.deepEqual(tradingPollingIntervals(lunchBreak), {
    trading: false,
    openingBurst: false,
    marketMs: 120_000,
    alertMs: 60_000,
  })
})

test('工作台接入动态周期且止损触价先落盘再立即确认', () => {
  assert.match(appSource, /const polling = tradingPollingIntervals\(\)/)
  assert.match(appSource, /const interval = polling\.marketMs/)
  assert.match(appSource, /const alertInterval = polling\.alertMs/)
  assert.match(alertStoreSource, /resolveImmediateConfirmationAlert/)
  assert.match(alertStoreSource, /flushSave: flushWatchingState/)
  assert.match(alertStoreSource, /_watchingFlushPromise/)
  assert.match(alertStoreSource, /if \(current\) this\._confirmWatching\(current, q\)/)
})
