import test from 'node:test'
import assert from 'node:assert/strict'

import {
  alertTimerBody,
  adviceTimerBody,
  adviceWorkerBody,
  dailyReportTimerBody,
  dailyReportWorkerBody,
  reviewTimerBody,
  sectorForecastTimerBody,
  v2AccuracyTimerBody,
} from '../api/_advice_timer.js'

test('阿里云定时事件只在触发器名称和密钥匹配时恢复任务', () => {
  const event = {
    triggerName: 'advice-resume-timer',
    triggerTime: '2026-08-10T00:00:00Z',
    payload: 'secret-key',
  }

  assert.deepEqual(adviceTimerBody(event, 'secret-key'), { resumeOnly: true, autoRefresh: true })
  assert.equal(adviceTimerBody(event, 'wrong-key'), null)
  assert.equal(adviceTimerBody({ ...event, triggerName: 'other' }, 'secret-key'), null)
  assert.equal(adviceTimerBody(event, ''), null)
})

test('V2正确率定时事件只接受专用触发器和匹配密钥', () => {
  const event = {
    triggerName: 'v2-accuracy-timer',
    triggerTime: '2026-08-10T07:15:00Z',
    payload: 'secret-key',
  }

  assert.deepEqual(v2AccuracyTimerBody(event, 'secret-key'), { scheduled: true })
  assert.equal(v2AccuracyTimerBody(event, 'wrong-key'), null)
  assert.equal(v2AccuracyTimerBody({ ...event, triggerName: 'other' }, 'secret-key'), null)
})

test('板块前瞻Timer只负责唤醒运行时到期判断', () => {
  const event = {
    triggerName: 'sector-forecast-due-timer',
    payload: 'secret-key',
  }

  assert.deepEqual(
    sectorForecastTimerBody(event, 'secret-key'),
    { action: 'run_due' },
  )
  assert.equal(sectorForecastTimerBody(event, 'wrong-key'), null)
  assert.equal(sectorForecastTimerBody({
    ...event,
    triggerName: 'other',
  }, 'secret-key'), null)
})

test('盯盘预警只接受交易时段专用Timer触发器和匹配密钥', () => {
  const names = [
    'alert-market-am-open',
    'alert-market-am-core',
    'alert-market-am-close',
    'alert-market-pm-core',
    'alert-market-pm-close',
  ]

  for (const triggerName of names) {
    assert.deepEqual(alertTimerBody({
      triggerName,
      triggerTime: '2026-08-13T01:30:00Z',
      payload: 'secret-key',
    }, 'secret-key'), {
      scheduled: true,
      roundMs: 8000,
      budgetMs: 50000,
    })
  }
  assert.equal(alertTimerBody({ triggerName: 'alert-market-other', payload: 'secret-key' }, 'secret-key'), null)
  assert.equal(alertTimerBody({ triggerName: names[0], payload: 'wrong-key' }, 'secret-key'), null)
  assert.equal(alertTimerBody({ triggerName: names[0], payload: 'secret-key' }, ''), null)
})

test('异步建议Worker事件只恢复指定账号且必须验证内部密钥', () => {
  const event = {
    source: 'stock-dashboard.advice-worker',
    key: 'secret-key',
    nick: '飞飞徐',
  }

  assert.deepEqual(adviceWorkerBody(event, 'secret-key'), {
    resumeOnly: true,
    worker: true,
    nick: '飞飞徐',
  })
  assert.equal(adviceWorkerBody(event, 'wrong-key'), null)
  assert.equal(adviceWorkerBody({ ...event, nick: '' }, 'secret-key'), null)
})

test('日报定时扫描只接受专用触发器和匹配密钥', () => {
  const event = {
    triggerName: 'daily-report-schedule-timer',
    payload: 'secret-key',
  }

  assert.deepEqual(
    dailyReportTimerBody(event, 'secret-key'),
    { scheduled: true },
  )
  assert.equal(dailyReportTimerBody(event, 'wrong-key'), null)
  assert.equal(dailyReportTimerBody({
    ...event,
    triggerName: 'other',
  }, 'secret-key'), null)
})

test('异步日报Worker事件只运行指定账号与场次', () => {
  const event = {
    source: 'stock-dashboard.daily-report-worker',
    key: 'secret-key',
    nick: '测试账号',
    session: 'morning',
    runKey: '2026-08-24:morning',
  }

  assert.deepEqual(dailyReportWorkerBody(event, 'secret-key'), {
    dailyReportWorker: true,
    nick: '测试账号',
    session: 'morning',
    runKey: '2026-08-24:morning',
  })
  assert.equal(dailyReportWorkerBody(event, 'wrong-key'), null)
  assert.equal(dailyReportWorkerBody({ ...event, session: 'other' }, 'secret-key'), null)
})

test('自动复盘Timer只接受午间和收盘专用触发器', () => {
  assert.deepEqual(reviewTimerBody({
    triggerName: 'review-noon-open',
    payload: 'secret-key',
  }, 'secret-key'), {
    scheduled: true,
    session: 'noon',
  })
  assert.deepEqual(reviewTimerBody({
    triggerName: 'review-close-late',
    payload: 'secret-key',
  }, 'secret-key'), {
    scheduled: true,
    session: 'close',
  })
  assert.equal(reviewTimerBody({
    triggerName: 'review-other',
    payload: 'secret-key',
  }, 'secret-key'), null)
  assert.equal(reviewTimerBody({
    triggerName: 'review-noon-open',
    payload: 'wrong-key',
  }, 'secret-key'), null)
})
