import test from 'node:test'
import assert from 'node:assert/strict'

import { adviceJobState, shouldApplyCloudBatch } from '../shared/adviceUiState.js'

test('空任务快照不显示批量完成条', () => {
  assert.equal(shouldApplyCloudBatch({
    total: 0,
    done: 0,
    running: false,
    items: [],
    at: Date.now(),
  }), false)
})

test('卡片可从批次进度识别排队、生成中和可取消状态', () => {
  const running = adviceJobState({
    serverMode: true,
    running: true,
    items: [{ code: '600000', status: 'running', phase: '正在分析量价' }],
  }, '600000')
  const queued = adviceJobState({
    serverMode: true,
    running: true,
    items: [{ code: '000001', status: 'queued', phase: '排队等待云端生成' }],
  }, '000001')

  assert.deepEqual(running, {
    active: true,
    status: 'running',
    label: '正在分析量价',
    cancelable: true,
    cloud: true,
  })
  assert.equal(queued.active, true)
  assert.equal(queued.label, '排队等待云端生成')
  assert.equal(queued.cancelable, true)
})
