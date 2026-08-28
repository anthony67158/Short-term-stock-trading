import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  acceptsGenerationResult,
  createAdviceSubmissionRegistry,
  adviceCompleteness,
  adviceConcurrency,
  batchConcurrency,
  generationOptions,
  validateBatchMode,
} from '../shared/adviceBatchPolicy.js'

const planTab = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)

const completeAdvice = {
  action: '持有',
  title: '守住支撑继续持有',
  actionPlan: '守住3.10元继续持有，跌破后减仓10手',
  nextOpenPlan: '高开减仓、平开持有、低开守3.10元',
  futurePlan: '最迟第5个交易日未兑现则退出',
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

test('深度批量固定最多两路并行，普通模式保持端点并发数', () => {
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

test('普通模式关闭深度思考并使用短预算', () => {
  assert.deepEqual(generationOptions(false), {
    deepMode: false,
    fastMode: true,
    forceReasoning: false,
    runtimeBudgetMs: 55000,
    timeoutMs: 70000,
    maxAttempts: 1,
  })
})

test('同一股票提交确认前快速与深度入口共用一把锁', () => {
  const registry = createAdviceSubmissionRegistry()

  assert.equal(registry.begin('600487', '亨通光电'), true)
  assert.equal(registry.begin('600487', '亨通光电'), false)
  assert.equal(registry.has('600487'), true)
  assert.deepEqual(registry.list(), [{
    code: '600487',
    name: '亨通光电',
  }])

  registry.end('600487')
  assert.equal(registry.has('600487'), false)
})

test('深度模式使用有界预算且不整轮自动重试', () => {
  assert.deepEqual(generationOptions(true), {
    deepMode: true,
    fastMode: false,
    forceReasoning: true,
    runtimeBudgetMs: 150000,
    timeoutMs: 165000,
    maxAttempts: 1,
  })
})

test('一次性生成界面明确区分普通生成与深度生成', () => {
  assert.match(planTab, /普通生成（\{selCount\}）/)
  assert.match(planTab, /深度生成（2路并行）/)
  assert.match(planTab, /正在后台\{batch\.deepMode \? '深度' : '普通'\}生成/)
  assert.doesNotMatch(planTab, /快速生成（\{selCount\}）/)
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

test('限时到价复核只需一类可追溯依据即可形成终局结论', () => {
  const quality = adviceCompleteness({
    action: '观望',
    title: '维持观望',
    actionPlan: '维持观望：本次触发结束，不新增复核价',
    invalidation: '本次触发价已消费',
    techNote: '现价已触发原计划，分时承接未确认',
    reviewDecision: {
      schemaVersion: 'triggered-review-decision.v1',
      terminal: true,
      outcome: '维持观望',
    },
  }, 'buy_advice')

  assert.equal(quality.complete, true)
  assert.deepEqual(quality.missing, [])
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
      missing: [
        '失效条件',
        '核心依据',
        '次日应对',
        '五日内退出路径',
      ],
    },
  )
})

test('持仓和实际买入建议必须包含次日应对与五日内退出路径', () => {
  assert.deepEqual(
    adviceCompleteness({
      ...completeAdvice,
      nextOpenPlan: '',
      futurePlan: '',
    }, 'hold_advice'),
    {
      complete: false,
      missing: ['次日应对', '五日内退出路径'],
    },
  )
  assert.deepEqual(
    adviceCompleteness({
      ...completeAdvice,
      action: '小仓试错',
      nextOpenPlan: '',
      futurePlan: '',
    }, 'buy_advice'),
    {
      complete: false,
      missing: ['次日应对', '五日内退出路径'],
    },
  )
  assert.equal(adviceCompleteness({
    ...completeAdvice,
    action: '观望',
    nextOpenPlan: '',
    futurePlan: '',
  }, 'buy_advice').complete, true)
})
