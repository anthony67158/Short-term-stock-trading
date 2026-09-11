import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  acceptsGenerationResult,
  createAdviceSubmissionRegistry,
  adviceCompleteness,
  adviceConcurrency,
  batchConcurrency,
  completeAdviceHorizonFields,
  DEFAULT_DECISION_CONCURRENCY,
  generationOptions,
  resolveDecisionConcurrency,
  validateBatchMode,
} from '../shared/adviceBatchPolicy.js'

const planTab = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)
const stockDetail = readFileSync(
  new URL('../src/components/StockDetail.jsx', import.meta.url),
  'utf8',
)
const adviceGate = readFileSync(
  new URL('../src/adviceGate.js', import.meta.url),
  'utf8',
)
const adviceBatch = readFileSync(
  new URL('../src/adviceBatch.js', import.meta.url),
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

test('系统批量决策不受解释端点限制并默认四路', () => {
  assert.equal(DEFAULT_DECISION_CONCURRENCY, 4)
  assert.equal(resolveDecisionConcurrency(undefined), 4)
  assert.equal(resolveDecisionConcurrency(6), 6)
  assert.equal(resolveDecisionConcurrency(99), 8)
  assert.equal(batchConcurrency(4, true), 4)
  assert.equal(batchConcurrency(1, true), 1)
  assert.equal(batchConcurrency(4, false), 4)
})

test('单股与批量决策评估使用同一独立容量', () => {
  assert.equal(adviceConcurrency(4, {
    deepMode: true,
    batchRequest: false,
  }), 4)
  assert.equal(adviceConcurrency(4, {
    deepMode: true,
    batchRequest: true,
  }), 4)
  assert.equal(adviceConcurrency(4, {
    deepMode: false,
    batchRequest: true,
  }), 4)
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

test('提交状态可被弹窗重新订阅并恢复原生成模式', () => {
  const registry = createAdviceSubmissionRegistry()
  const snapshots = []
  const unsubscribe = registry.subscribe(() => {
    snapshots.push(registry.get('600487'))
  })

  registry.begin('600487', '亨通光电', {
    deepMode: true,
    stage: 'submitting',
    phase: '正在同步账本并提交云端任务',
  })

  assert.deepEqual(registry.get('600487'), {
    code: '600487',
    name: '亨通光电',
    deepMode: true,
    stage: 'submitting',
    phase: '正在同步账本并提交云端任务',
  })
  assert.equal(snapshots.length, 1)

  registry.end('600487')
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[1], null)
  unsubscribe()
})

test('个股弹窗重开后从全局提交状态恢复进度', () => {
  assert.match(adviceGate, /export function getAdviceSubmission/)
  assert.match(adviceGate, /export function subscribeAdviceSubmissions/)
  assert.match(adviceGate, /adviceSubmissionResolution/)
  assert.match(adviceGate, /SERVER_SUBMISSION_PENDING_MESSAGE/)
  assert.match(adviceGate, /正在同步账本并提交云端任务/)
  assert.match(stockDetail, /getAdviceSubmission\(code\)/)
  assert.match(stockDetail, /subscribeAdviceSubmissions\(sync\)/)
  assert.match(stockDetail, /submission\.deepMode === true/)
  assert.ok(
    stockDetail.indexOf('const submission = getAdviceSubmission(code)')
      < stockDetail.indexOf('if (failedCloudItem)'),
  )
})

test('深度模式使用有界预算且不整轮自动重试', () => {
  assert.deepEqual(generationOptions(true), {
    deepMode: true,
    fastMode: false,
    forceReasoning: true,
    runtimeBudgetMs: 540000,
    timeoutMs: 555000,
    maxAttempts: 1,
  })
})

test('持仓页复用现有任务链批量更新V3决策', () => {
  assert.doesNotMatch(planTab, /普通生成（\{selCount\}）/)
  assert.doesNotMatch(planTab, /深度生成（2路并行）/)
  assert.doesNotMatch(planTab, /className="batch-bar"/)
  assert.match(planTab, /function DecisionBatchControl/)
  assert.match(planTab, /runManualAdviceRefresh\('both', quote \|\| \{\}\)/)
  assert.match(planTab, /批量更新决策 · \$\{count\}只/)
  assert.match(planTab, /<DecisionBatchProgress quote=\{quote\} \/>/)
  assert.match(planTab, /aria-label="V3批量更新进度"/)
  assert.match(planTab, />\s*纳入作战\s*</)
  assert.match(planTab, /<AdviceGenerationStatus code=\{p\.code\}/)
})

test('新批次提交期间不被上一批云端终态覆盖', () => {
  assert.match(
    adviceBatch,
    /state\._submissionPromise[\s\S]*?state\.running[\s\S]*?state\.serverMode[\s\S]*?cloudBatchId !== state\.batchId[\s\S]*?return/,
  )
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

test('模型遗漏持仓时间计划时按风控字段补齐而不丢弃其余结论', () => {
  const advice = completeAdviceHorizonFields({
    ...completeAdvice,
    nextOpenPlan: '',
    futurePlan: '',
  }, 'hold_advice')

  assert.match(advice.nextOpenPlan, /高开/)
  assert.match(advice.nextOpenPlan, /平开/)
  assert.match(advice.nextOpenPlan, /低开/)
  assert.match(advice.futurePlan, /1-5/)
  assert.equal(adviceCompleteness(advice, 'hold_advice').complete, true)
})
