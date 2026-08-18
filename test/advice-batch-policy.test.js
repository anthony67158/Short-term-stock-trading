import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptsGenerationResult,
  adviceCompleteness,
  adviceConcurrency,
  batchConcurrency,
  generationOptions,
  validateBatchMode,
} from '../shared/adviceBatchPolicy.js'

const completeAdvice = {
  action: '持有',
  title: '守住支撑继续持有',
  actionPlan: '守住3.10元继续持有，跌破后减仓10手',
  invalidation: '放量跌破3.10元且无法收回时计划失效',
  quantNote: '量化评分51.1分，方向中性',
  fundNote: '主力资金连续流出，反弹承压',
}

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

test('所有任务只有完整AI建议才能计为成功', () => {
  assert.equal(
    acceptsGenerationResult({
      advice: completeAdvice,
      truncated: false,
    }, 'hold_advice'),
    true,
  )
  assert.equal(
    acceptsGenerationResult({
      quant: { score: 60 },
      advice: completeAdvice,
      truncated: true,
    }, 'hold_advice'),
    false,
  )
  assert.equal(
    acceptsGenerationResult({
      quant: { score: 60 },
      advice: { action: '持有' },
      truncated: false,
    }, 'hold_advice'),
    false,
  )
  assert.equal(
    acceptsGenerationResult({
      quant: { score: 60 },
    }, 'hold_advice'),
    false,
  )
  assert.equal(
    acceptsGenerationResult({ unchanged: true }, 'hold_advice'),
    true,
  )
})

test('完整度契约要求结论执行失效条件与至少两类依据', () => {
  assert.deepEqual(adviceCompleteness(completeAdvice, 'hold_advice'), {
    complete: true,
    missing: [],
  })
  assert.deepEqual(
    adviceCompleteness({
      action: '持有',
      title: '继续持有',
      actionPlan: '守住3.10元继续持有',
      quantNote: '量化中性',
    }, 'hold_advice'),
    {
      complete: false,
      missing: ['失效条件', '核心依据'],
    },
  )
})
