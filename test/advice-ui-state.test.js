import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceJobState,
  adviceGenerationSteps,
  cloudAdviceLoadingState,
  createAdviceCompletionPuller,
  mergeAdviceRefreshState,
  newestAdviceResult,
  shouldShowAdviceResult,
  shouldApplyCloudBatch,
} from '../shared/adviceUiState.js'

test('快速军师用可验证阶段展示流程而不依赖隐藏思维链', () => {
  const steps = adviceGenerationSteps({
    stage: 'quant',
    phase: '行情 / 资金 / 消息面已就位，正在量化打分',
    deepMode: false,
  })

  assert.deepEqual(
    steps.map((step) => [step.key, step.state]),
    [
      ['prepare', 'done'],
      ['collect', 'done'],
      ['quant', 'active'],
      ['decision', 'pending'],
    ],
  )
  assert.equal(steps.some((step) => step.key === 'reasoning'), false)
})

test('深度研判先形成候选方案并复核，最后才发布最终结论', () => {
  const drafting = adviceGenerationSteps({
    stage: 'llm',
    phase: '数据齐全，正在生成操作建议',
    deepMode: true,
  })
  const reviewing = adviceGenerationSteps({
    stage: 'council',
    phase: '委员会正在复核候选方案',
    deepMode: true,
  })
  const finalizing = adviceGenerationSteps({
    stage: 'finalize',
    phase: '复核完成，正在发布最终结论',
    deepMode: true,
  })

  assert.deepEqual(
    drafting.map((step) => [step.key, step.label, step.state]),
    [
      ['prepare', '准备上下文', 'done'],
      ['collect', '采集证据', 'done'],
      ['quant', '量化校验', 'done'],
      ['draft', '形成候选方案', 'active'],
      ['council', '委员会复核', 'pending'],
      ['decision', '发布最终结论', 'pending'],
    ],
  )
  assert.deepEqual(
    reviewing.map((step) => [step.key, step.state]),
    [
      ['prepare', 'done'],
      ['collect', 'done'],
      ['quant', 'done'],
      ['draft', 'done'],
      ['council', 'active'],
      ['decision', 'pending'],
    ],
  )
  assert.equal(finalizing.at(-1).state, 'active')
  assert.equal(
    finalizing.find((step) => step.key === 'council')?.state,
    'done',
  )
})

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
  const runner = {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      title: '旧结果',
      actionPlan: '守住10元继续持有',
      invalidation: '跌破9.8元失效',
      quantNote: '量化中性',
      fundNote: '资金稳定',
    },
    cachedAt: 100,
  }
  const cloud = {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      title: '本次批量结果',
      actionPlan: '守住10.1元继续持有',
      invalidation: '跌破9.9元失效',
      quantNote: '量化偏多',
      fundNote: '资金流入',
    },
    at: 200,
  }

  assert.deepEqual(newestAdviceResult(runner, cloud), {
    source: 'cache',
    value: cloud,
  })
  assert.deepEqual(newestAdviceResult({ ...runner, cachedAt: 300 }, cloud), {
    source: 'runner',
    value: { ...runner, cachedAt: 300 },
  })
})

test('更新的截断半成品不能覆盖上一版完整建议', () => {
  const complete = {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      title: '上一版完整结论',
      actionPlan: '守住3.10元继续持有',
      invalidation: '放量跌破3.10元失效',
      quantNote: '量化中性',
      fundNote: '资金承压',
    },
    cachedAt: 100,
  }
  const partial = {
    mode: 'hold_advice',
    advice: { action: '持有' },
    truncated: true,
    at: 200,
  }

  assert.deepEqual(
    newestAdviceResult(complete, partial, 'hold_advice'),
    { source: 'runner', value: complete },
  )
  assert.deepEqual(
    newestAdviceResult(null, partial, 'hold_advice'),
    { source: null, value: null },
  )
})

test('手动或自动刷新期间继续展示最近一次完整建议', () => {
  const previous = {
    result: { score: 66 },
    advice: { action: '持有', actionPlan: '守住支撑继续持有' },
    cachedAt: 100,
  }
  const loading = {
    loading: true,
    cloud: true,
    phase: '正在采集最新证据',
    sources: [{ label: '实时行情', ok: true }],
  }

  assert.deepEqual(mergeAdviceRefreshState(loading, previous), {
    ...previous,
    ...loading,
    showingPrevious: true,
  })
  assert.deepEqual(mergeAdviceRefreshState(loading, null), {
    ...loading,
    showingPrevious: false,
  })
  assert.equal(shouldShowAdviceResult({
    ...previous,
    loading: true,
  }), true)
  assert.equal(shouldShowAdviceResult({ loading: true }), false)
})

test('个股建仓后不再展示旧的未持仓买入建议', () => {
  const oldBuyAdvice = {
    mode: 'buy_advice',
    advice: { action: '观望', tier: 'wait' },
    at: 300,
  }
  const holdAdvice = {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      title: '继续持有',
      actionPlan: '守住10元继续持有',
      invalidation: '跌破9.8元失效',
      quantNote: '量化中性',
      fundNote: '资金稳定',
      pnlNote: '当前浮盈',
    },
    cachedAt: 200,
  }

  assert.deepEqual(
    newestAdviceResult(holdAdvice, oldBuyAdvice, 'hold_advice'),
    { source: 'runner', value: holdAdvice },
  )
  assert.deepEqual(
    newestAdviceResult(null, oldBuyAdvice, 'hold_advice'),
    { source: null, value: null },
  )
})

test('服务端单股任务回灌阶段、数据源、模型与推理文本', () => {
  const batch = {
    serverMode: true,
    items: [{
      code: '600519',
      status: 'running',
      stage: 'llm',
      phase: '正在生成操作建议',
      sources: [{ label: '个股K线', ok: true }],
      reasoning: '先判断趋势，再核对量化概率和价格锚点。',
      model: 'DeepSeek-V4-Pro',
      endpoint: '主端点',
      deepMode: false,
    }],
  }

  const loading = cloudAdviceLoadingState(batch, '600519')

  assert.equal(loading.loading, true)
  assert.equal(loading.cloud, true)
  assert.equal(loading.phase, '正在生成操作建议')
  assert.equal(loading.stage, 'llm')
  assert.equal(loading.deepMode, false)
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
    stage: '',
    label: '正在分析量价',
    cancelable: true,
    cloud: true,
    deepMode: false,
  })
  assert.equal(queued.active, true)
  assert.equal(queued.label, '排队等待云端生成')
  assert.equal(queued.cancelable, true)
})

test('服务端建议完成后立即拉取一次正文且重复状态不重复拉取', async () => {
  const pulled = []
  const pullCompletedAdvice = createAdviceCompletionPuller(async () => {
    pulled.push(Date.now())
  })

  assert.equal(await pullCompletedAdvice({
    running: true,
    items: [{ code: '600487', status: 'running', progressAt: 100 }],
  }), false)
  assert.equal(await pullCompletedAdvice({
    running: false,
    items: [{ code: '600487', status: 'ok', progressAt: 200 }],
  }), true)
  assert.equal(await pullCompletedAdvice({
    running: false,
    items: [{ code: '600487', status: 'ok', progressAt: 200 }],
  }), false)
  assert.equal(pulled.length, 1)
})
