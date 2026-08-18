import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldRunAlertCron } from '../api/cron_alert.js'

test('盯盘定时任务只在真实A股连续竞价窗口运行', () => {
  const regularTrading = Date.parse('2026-08-12T02:00:00Z')
  const lunchBreak = Date.parse('2026-08-12T04:00:00Z')
  const marketHoliday = Date.parse('2026-10-01T02:00:00Z')

  assert.equal(shouldRunAlertCron(regularTrading), true)
  assert.equal(shouldRunAlertCron(lunchBreak), false)
  assert.equal(shouldRunAlertCron(marketHoliday), false)
})
