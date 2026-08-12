import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceTimerBody,
  adviceWorkerBody,
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
