import test from 'node:test'
import assert from 'node:assert/strict'

import {
  beijingMinutes,
  isContinuousTrading,
  isStockPickSession,
  isTradingDayAt,
  localDateKey,
  nextTradingDate,
  nextTradingDayLabel,
  tradingCalendarCoverage,
} from '../shared/tradingCalendar.js'

test('交易日历统一按北京时间识别节假日和连续竞价窗口', () => {
  const holiday = Date.parse('2026-10-01T02:00:00Z')
  const morningOpen = Date.parse('2026-08-12T01:30:00Z')
  const lunchBreak = Date.parse('2026-08-12T04:00:00Z')
  const afterClose = Date.parse('2026-08-12T07:01:00Z')

  assert.equal(isTradingDayAt(holiday), false)
  assert.equal(isContinuousTrading(holiday), false)
  assert.equal(beijingMinutes(morningOpen), 570)
  assert.equal(isContinuousTrading(morningOpen), true)
  assert.equal(isContinuousTrading(lunchBreak), false)
  assert.equal(isContinuousTrading(afterClose), false)
})

test('选股业务窗口包含午休但仍排除非交易日', () => {
  const lunchBreak = Date.parse('2026-08-12T04:00:00Z')
  const holiday = Date.parse('2026-10-01T04:00:00Z')

  assert.equal(isStockPickSession(lunchBreak), true)
  assert.equal(isStockPickSession(holiday), false)
})

test('下一交易日跳过国庆休市和周末', () => {
  const beforeHoliday = Date.parse('2026-09-30T08:00:00Z')
  const next = nextTradingDate(beforeHoliday)

  assert.equal(localDateKey(next), '2026-10-08')
  assert.equal(nextTradingDayLabel(beforeHoliday), '下一交易日周四(10-08)')
})

test('交易日历超出维护范围时自动任务失败关闭', () => {
  const future = Date.parse('2027-01-04T02:00:00Z')
  const coverage = tradingCalendarCoverage(future)

  assert.equal(coverage.covered, false)
  assert.equal(coverage.through, '2026-12-31')
  assert.equal(isTradingDayAt(future), false)
  assert.equal(isContinuousTrading(future), false)
  assert.equal(nextTradingDayLabel(future), '交易日历待更新')
})
