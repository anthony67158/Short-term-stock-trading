import test from 'node:test'
import assert from 'node:assert/strict'

import { isActiveTailPickTask } from '../src/tailPickClient.js'

test('尾盘任务在排队和运行阶段都保持轮询', () => {
  assert.equal(isActiveTailPickTask({ status: 'QUEUED' }), true)
  assert.equal(isActiveTailPickTask({ status: 'RUNNING' }), true)
  assert.equal(isActiveTailPickTask({ status: 'DONE' }), false)
  assert.equal(isActiveTailPickTask({ status: 'FAILED' }), false)
  assert.equal(isActiveTailPickTask(null), false)
})
