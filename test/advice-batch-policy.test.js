import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptsGenerationResult,
  adviceConcurrency,
  batchConcurrency,
  generationOptions,
  validateBatchMode,
} from '../shared/adviceBatchPolicy.js'

test('深度批量允许全选，不限制总股票数量', () => {
  const codes = Array.from({ length: 24 }, (_, index) => String(index + 1))
  assert.deepEqual(validateBatchMode(codes, true), {
    ok: true,
    count: 24,
    deepMode: true,
  })
})

test('深度批量固定最多两路并行，快速模式保持端点并发数', () => {
  assert.equal(batchConcurrency(3, true), 2)
  assert.equal(batchConcurrency(1, true), 1)
  assert.equal(batchConcurrency(3, false), 3)
})

test('单股深度生成使用全部军师端点，只有一次性深度批量限制两路', () => {
  assert.equal(adviceConcurrency(3, {
    deepMode: true,
    batchRequest: false,
  }), 3)
  assert.equal(adviceConcurrency(3, {
    deepMode: true,
    batchRequest: true,
  }), 2)
  assert.equal(adviceConcurrency(3, {
    deepMode: false,
    batchRequest: true,
  }), 3)
})

test('快速模式关闭深度思考并使用短预算', () => {
  assert.deepEqual(generationOptions(false), {
    deepMode: false,
    fastMode: true,
    forceReasoning: false,
    runtimeBudgetMs: 120000,
    timeoutMs: 135000,
    maxAttempts: 3,
  })
})

test('深度模式启用长预算并自动重试', () => {
  assert.deepEqual(generationOptions(true), {
    deepMode: true,
    fastMode: false,
    forceReasoning: true,
    runtimeBudgetMs: 480000,
    timeoutMs: 495000,
    maxAttempts: 3,
  })
})

test('深度任务只有完整AI建议才能计为成功', () => {
  assert.equal(acceptsGenerationResult({ advice: { action: '持有' }, truncated: false }, true), true)
  assert.equal(acceptsGenerationResult({ advice: { action: '持有' }, truncated: true }, true), false)
  assert.equal(acceptsGenerationResult({ quant: { score: 60 } }, true), false)
  assert.equal(acceptsGenerationResult({ quant: { score: 60 } }, false), true)
  assert.equal(acceptsGenerationResult({ unchanged: true }, false), true)
})
