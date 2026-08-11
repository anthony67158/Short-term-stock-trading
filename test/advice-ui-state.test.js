import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceJobState,
  cloudAdviceLoadingState,
  newestAdviceResult,
  shouldApplyCloudBatch,
} from '../shared/adviceUiState.js'

test('空任务快照不显示批量完成条', () => {
  assert.equal(shouldApplyCloudBatch({
    total: 0,
    done: 0,
    running: false,
    items: [],
    at: Date.now(),
  }), false)
})

test('个股详情优先展示生成时间更新的云端批量结果', () => {
  const runner = { advice: { title: '旧结果' }, cachedAt: 100 }
  const cloud = { advice: { title: '本次批量结果' }, at: 200 }

  assert.deepEqual(newestAdviceResult(runner, cloud), {
    source: 'cache',
    value: cloud,
  })
  assert.deepEqual(newestAdviceResult({ ...runner, cachedAt: 300 }, cloud), {
    source: 'runner',
    value: { ...runner, cachedAt: 300 },
  })
})

test('服务端单股任务回灌阶段、数据源、模型与推理文本', () => {
  const batch = {
    serverMode: true,
    items: [{
      code: '600519',
      status: 'running',
      phase: '正在生成操作建议',
      sources: [{ label: '个股K线', ok: true }],
      reasoning: '先判断趋势，再核对量化概率和价格锚点。',
      model: 'DeepSeek-V4-Pro',
      endpoint: '主端点',
    }],
  }

  const loading = cloudAdviceLoadingState(batch, '600519')

  assert.equal(loading.loading, true)
  assert.equal(loading.cloud, true)
  assert.equal(loading.phase, '正在生成操作建议')
  assert.deepEqual(loading.sources, [{ label: '个股K线', ok: true }])
  assert.match(loading.reasoning, /判断趋势/)
  assert.equal(loading.model, 'DeepSeek-V4-Pro')
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
