import test from 'node:test'
import assert from 'node:assert/strict'

import { adviceTimerBody } from '../api/_advice_timer.js'

test('阿里云定时事件只在触发器名称和密钥匹配时恢复任务', () => {
  const event = {
    triggerName: 'advice-resume-timer',
    triggerTime: '2026-08-10T00:00:00Z',
    payload: 'secret-key',
  }

  assert.deepEqual(adviceTimerBody(event, 'secret-key'), { resumeOnly: true })
  assert.equal(adviceTimerBody(event, 'wrong-key'), null)
  assert.equal(adviceTimerBody({ ...event, triggerName: 'other' }, 'secret-key'), null)
  assert.equal(adviceTimerBody(event, ''), null)
})
