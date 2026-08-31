import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceJobState,
  adviceReviewCardState,
  adviceGenerationSteps,
  cloudAdviceLoadingState,
  createAdviceCompletionPuller,
  mergeCloudAdviceItems,
  mergeAdviceRefreshState,
  newestAdviceResult,
  serverFallbackDisplayState,
  startAdvicePersistently,
  shouldShowAdviceResult,
  shouldApplyCloudBatch,
  shouldApplyCloudProgressSnapshot,
} from '../shared/adviceUiState.js'

test('本地中断转云端时只有未确认提交短暂保留等待态', () => {
  assert.equal(
    serverFallbackDisplayState({ ok: true }, 1_000),
    null,
  )
  assert.deepEqual(
    serverFallbackDisplayState({
      ok: false,
      queued: true,
      error: '提交结果未确认',
    }, 1_000),
    {
      pending: true,
      error: '提交结果未确认',
      cachedAt: 1_000,
      expiresAt: 31_000,
    },
  )
  assert.deepEqual(
    serverFallbackDisplayState({
      ok: false,
      error: '云端拒绝任务',
    }, 1_000),
    {
      error: '云端拒绝任务',
      cachedAt: 1_000,
    },
  )
})

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

test('到价复核先展示持续观察再采集证据和给出终局结论', () => {
  const steps = adviceGenerationSteps({
    role: 'review',
    triggerKind: 'price-review',
    stage: 'monitoring',
    phase: '持续观察回踩后的承接',
    deepMode: false,
  })

  assert.deepEqual(
    steps.map((step) => [step.key, step.label, step.state]),
    [
      ['monitoring', '持续观察', 'active'],
      ['collect', '采集最新证据', 'pending'],
      ['decision', '给出终局结论', 'pending'],
    ],
  )
})

test('深度研判完成后直接发布最终结论', () => {
  const drafting = adviceGenerationSteps({
    stage: 'llm',
    phase: '数据齐全，正在生成操作建议',
    deepMode: true,
  })
  const finalizing = adviceGenerationSteps({
    stage: 'finalize',
    phase: '正在发布最终结论',
    deepMode: true,
  })

  assert.deepEqual(
    drafting.map((step) => [step.key, step.label, step.state]),
    [
      ['prepare', '准备上下文', 'done'],
      ['collect', '采集证据', 'done'],
      ['quant', '量化校验', 'done'],
      ['draft', '深度研判', 'active'],
      ['decision', '发布最终结论', 'pending'],
    ],
  )
  assert.equal(finalizing.at(-1).state, 'active')
  assert.equal(finalizing.some((step) => step.key === 'council'), false)
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

test('相同时间戳的发布终态变化仍必须回灌客户端', () => {
  const publishing = {
    at: 2000,
    running: true,
    total: 1,
    done: 0,
    ok: 0,
    fail: 0,
    skipped: 0,
    items: [{
      code: '000636',
      jobId: 'job-1',
      status: 'publishing',
    }],
    reviews: [],
  }
  const completed = {
    ...publishing,
    running: false,
    done: 1,
    ok: 1,
    items: [{
      code: '000636',
      jobId: 'job-1',
      status: 'ok',
    }],
  }

  assert.equal(
    shouldApplyCloudProgressSnapshot(publishing, completed),
    true,
  )
  assert.equal(
    shouldApplyCloudProgressSnapshot(completed, completed),
    false,
  )
  assert.equal(
    shouldApplyCloudProgressSnapshot(completed, {
      ...publishing,
      at: 1999,
    }),
    false,
  )
})

test('相同进度时间新增准备超时警告时仍必须回灌客户端', () => {
  const current = {
    at: 2000,
    running: true,
    total: 1,
    items: [{
      code: '600000',
      jobId: 'job-1',
      status: 'running',
      stage: 'collect',
      phase: '正在读取账户与实时行情',
      progressAt: 2000,
      warning: '',
    }],
    reviews: [],
  }
  const warned = {
    ...current,
    items: [{
      ...current.items[0],
      warning: '部分数据源响应较慢，超时后将自动跳过并继续',
    }],
  }

  assert.equal(
    shouldApplyCloudProgressSnapshot(current, warned),
    true,
  )
})

test('个股详情优先展示生成时间更新的云端批量结果', () => {
  const runner = {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      title: '旧结果',
      actionPlan: '守住10元继续持有',
      nextOpenPlan: '次日高开减仓、平开持有、低开守止损',
      futurePlan: '最迟第5个交易日退出',
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
      nextOpenPlan: '次日高开减仓、平开持有、低开守止损',
      futurePlan: '最迟第5个交易日退出',
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
      nextOpenPlan: '次日高开减仓、平开持有、低开守止损',
      futurePlan: '最迟第5个交易日退出',
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
      nextOpenPlan: '次日高开减仓、平开持有、低开守止损',
      futurePlan: '最迟第5个交易日退出',
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

test('发布中保持生成态且不允许误取消', () => {
  const publishing = adviceJobState({
    serverMode: true,
    running: true,
    items: [{
      code: '600000',
      status: 'publishing',
      stage: 'finalize',
      phase: '正在核验并发布最终结论',
    }],
  }, '600000')

  assert.deepEqual(publishing, {
    active: true,
    status: 'publishing',
    stage: 'finalize',
    label: '正在核验并发布最终结论',
    cancelable: false,
    cloud: true,
    deepMode: false,
  })
})

test('同一任务完成后拒绝迟到的运行中快照', () => {
  const merged = mergeCloudAdviceItems(
    [{
      code: '600000',
      jobId: 'job-1',
      status: 'ok',
      stage: 'done',
    }],
    [{
      code: '600000',
      jobId: 'job-1',
      status: 'running',
      stage: 'llm',
    }],
  )

  assert.deepEqual(merged, [{
    code: '600000',
    jobId: 'job-1',
    status: 'ok',
    stage: 'done',
  }])
})

test('后台复核保持卡片可见但不占用或取消advisor生成', () => {
  const batch = {
    serverMode: true,
    running: false,
    items: [],
    reviews: [{
      code: '600000',
      status: 'running',
      phase: '正在核对最新失效信号',
    }],
  }

  assert.equal(adviceJobState(batch, '600000'), null)
  assert.deepEqual(
    adviceJobState(batch, '600000', { role: 'review' }),
    {
      active: true,
      status: 'running',
      role: 'review',
      stage: '',
      label: '正在核对最新失效信号',
      cancelable: false,
      cloud: true,
      deepMode: false,
    },
  )
  assert.equal(
    cloudAdviceLoadingState(batch, '600000').role,
    'review',
  )
})

test('卡片复核状态只由真实price-review任务状态驱动', () => {
  const now = 10_000
  const alerts = [{
    id: 'review-alert',
    code: '600000',
    candCode: '600000',
    reviewOnly: true,
    enabled: false,
    phase: 'reviewing',
    triggeredAt: 5_000,
  }]
  const stateFor = (status, extra = {}) => adviceReviewCardState({
    reviews: [{
      code: '600000',
      role: 'review',
      source: 'judge',
      triggerKind: 'price-review',
      status,
      progressAt: 8_000,
      ...extra,
    }],
  }, '600000', { alerts, now })

  assert.deepEqual(
    adviceReviewCardState({ reviews: [] }, '600000', { alerts, now }),
    {
      kind: 'queued',
      label: '条件已触发，正在启动持续观察',
      detail: '持续观察后，在2分钟内给出明确结论',
    },
  )
  assert.equal(stateFor('queued').label, '条件已触发，等待后台复核')
  assert.equal(stateFor('running').label, '到价终局复核中')
  assert.deepEqual(stateFor('running', {
    stage: 'monitoring',
    monitoringUntilAt: 70_000,
    phase: '持续观察回踩后的承接',
  }), {
    kind: 'monitoring',
    label: '触价后持续观察中',
    detail: '持续观察回踩后的承接',
  })
  assert.equal(stateFor('publishing').label, '复核完成，正在更新结论')
  assert.equal(stateFor('ok').label, '到价复核完成，已给出明确结论')
  assert.equal(adviceReviewCardState({
    reviews: [{
      code: '600000',
      role: 'review',
      source: 'judge',
      triggerKind: 'price-review',
      status: 'ok',
      progressAt: 8_000,
    }],
  }, '600000', { alerts: [], now }).label, '到价复核完成，已给出明确结论')
  assert.deepEqual(stateFor('fail', { error: '模型超时' }), {
    kind: 'failed',
    label: '自动复核失败，请重新评估',
    detail: '模型超时',
  })
  assert.equal(stateFor('skipped').label, '自动复核已停止')
})

test('触价超过总期限缓冲仍没有后台任务时明确提示启动失败', () => {
  const alerts = [{
    id: 'review-alert',
    code: '600000',
    candCode: '600000',
    reviewOnly: true,
    enabled: false,
    phase: 'reviewing',
    triggeredAt: 1_000,
  }]

  assert.deepEqual(adviceReviewCardState(
    { reviews: [] },
    '600000',
    { alerts, now: 160_000 },
  ), {
    kind: 'failed',
    label: '自动复核未启动，点“重新评估”立即处理',
    detail: '到价任务未成功启动，需手动重新评估当前信号',
  })
})

test('最新建议已晚于触价时间时不再显示旧的等待复核', () => {
  const alerts = [{
    id: 'stale-review-alert',
    code: '600601',
    candCode: '600601',
    reviewOnly: true,
    enabled: false,
    phase: 'reviewing',
    triggeredAt: 1_000,
  }]

  assert.equal(adviceReviewCardState(
    { reviews: [] },
    '600601',
    {
      alerts,
      adviceAt: 2_000,
      now: 3_000,
    },
  ), null)
})

test('普通定时复核与过期完成状态不占用到价复核提示', () => {
  const now = 500_000
  assert.equal(adviceReviewCardState({
    reviews: [{
      code: '600000',
      role: 'review',
      source: 'auto',
      status: 'running',
      progressAt: now,
    }],
  }, '600000', { alerts: [], now }), null)

  assert.equal(adviceReviewCardState({
    reviews: [{
      code: '600000',
      role: 'review',
      source: 'judge',
      triggerKind: 'price-review',
      status: 'ok',
      progressAt: now - 180_000,
    }],
  }, '600000', { alerts: [], now }), null)
})

test('服务端advisor容量已满时不回退到本地重复生成', async () => {
  let localStarts = 0
  const result = await startAdvicePersistently({
    code: '600000',
    mode: 'hold_advice',
  }, {
    canUseServer: () => true,
    triggerServer: async () => ({
      ok: false,
      code: 'ADVISOR_CAPACITY_FULL',
      busy: [{ code: '000001', name: '已运行任务' }],
      concurrency: 1,
    }),
    startLocal: () => { localStarts++ },
  })

  assert.equal(result.status, 'full')
  assert.equal(result.concurrency, 1)
  assert.equal(localStarts, 0)
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

test('独立review完成后同样触发一次建议正文增量拉取', async () => {
  let pulls = 0
  const pullCompletedAdvice = createAdviceCompletionPuller(async () => {
    pulls++
  })

  assert.equal(await pullCompletedAdvice({
    running: false,
    items: [],
    reviews: [{
      code: '600519',
      role: 'review',
      status: 'running',
      progressAt: 100,
    }],
  }), false)
  assert.equal(await pullCompletedAdvice({
    running: false,
    items: [],
    reviews: [{
      code: '600519',
      role: 'review',
      status: 'ok',
      progressAt: 200,
    }],
  }), true)
  assert.equal(pulls, 1)
})
