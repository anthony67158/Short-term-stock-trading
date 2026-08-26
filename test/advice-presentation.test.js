import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAdvicePresentation,
  compileAdvicePresentationV3,
  trustCalibrationText,
} from '../shared/advicePresentation.js'

test('军师展示契约固定输出结论执行价位触发和三条核心依据', () => {
  const view = buildAdvicePresentation({
    action: '回调再买',
    tone: 'red',
    title: '等待回踩支撑后分批建仓',
    confidence: '中',
    actionPlan: '回踩10.00~10.10元企稳后买入2手',
    planQty: 2,
    planAmount: 2020,
    planWeight: '约占总资产8%',
    buyZone: '10.00~10.10',
    targetPrice: 11,
    stopPrice: 9.6,
    exitTiming: '放量跌破9.60元且无法收回再止损',
    invalidation: '收盘跌破9.60元',
    quantNote: '量化上涨概率62%，目标中枢11.00元',
    fundNote: '主力资金连续两日净流入',
    techNote: '10.00元附近是20日线支撑',
    newsNote: '近期无明显利空',
    knowledgeActionPlan: {
      triggerConditions: '回踩10.00~10.10元并重新站上VWAP',
      invalidation: '收盘跌破9.60元',
      validationWindow: '3个交易日',
    },
    reviewCycle: {
      status: 'scheduled',
      sequence: 3,
      reviewedAt: 1786327200000,
      nextReviewAt: 1786328100000,
      previousAction: '观望',
      changeType: 'adjust',
      reason: '关键证据发生实质变化',
    },
  })

  assert.deepEqual(view.verdict, {
    action: '回调再买',
    title: '等待回踩支撑后分批建仓',
    tone: 'red',
    confidence: '中',
  })
  assert.equal(view.execution.instruction, '回踩10.00~10.10元企稳后买入2手')
  assert.equal(view.execution.quantity, '2手')
  assert.equal(view.execution.amount, '2020')
  assert.equal(view.execution.position, '约占总资产8%')
  assert.deepEqual(view.planSteps, [])
  assert.deepEqual(
    view.levels.map((item) => item.label),
    ['买入区间', '目标价', '止损价'],
  )
  assert.match(view.trigger.condition, /VWAP/)
  assert.match(view.trigger.confirmation, /放量跌破/)
  assert.match(view.trigger.invalidation, /9.60/)
  assert.equal(view.trigger.validationWindow, '3个交易日')
  assert.deepEqual(
    view.evidence.map((item) => item.label),
    ['量化', '资金', '趋势'],
  )
  assert.equal(view.model, null)
  assert.deepEqual(view.review, {
    status: 'scheduled',
    sequence: 3,
    reviewedAt: 1786327200000,
    nextReviewAt: 1786328100000,
    previousAction: '观望',
    changeType: 'adjust',
    reason: '关键证据发生实质变化',
    receipt: null,
  })
  assert.equal(view.schemaVersion, 'advice-presentation.v3')
})

test('后端展示契约携带人工执行计划摘要且前端优先消费该契约', () => {
  const advice = {
    action: '减仓',
    title: '反弹减仓一手',
    actionPlan: '10元附近减仓1手',
    executionPlan: {
      schemaVersion: 'execution-plan.v1',
      planId: 'execution.demo',
      decisionId: 'decision.demo',
      status: 'DRAFT',
      canArm: true,
      side: 'SELL',
      targetLots: 1,
      filledLots: 0,
      remainingLots: 1,
      referencePrice: 10,
      validUntil: '2026-08-21T03:00:00.000Z',
      executionMethod: {
        type: 'SINGLE_LIMIT',
        label: '单笔限价',
      },
      slices: [{ lots: 1 }],
    },
  }
  const contract = compileAdvicePresentationV3(advice)
  const consumed = buildAdvicePresentation({
    ...advice,
    title: '不应覆盖服务端契约',
    presentation: contract,
  })

  assert.equal(contract.schemaVersion, 'advice-presentation.v3')
  assert.equal(contract.executionPlan.planId, 'execution.demo')
  assert.equal(contract.executionPlan.canArm, true)
  assert.equal(contract.executionPlan.methodLabel, '单笔限价')
  assert.equal(consumed.verdict.title, '反弹减仓一手')
})

test('历史信心校准明确展示样本数和同档命中率', () => {
  assert.equal(
    trustCalibrationText({
      calibrated: true,
      calibrationSamples: 14,
      historicalWinRate: 43,
    }),
    '已按同信心档14次结果校准 · 历史命中率43%',
  )
  assert.equal(trustCalibrationText({ calibrated: false }), '')
})

test('长段关注价说明不挤入价格格且后续路径默认收进完整分析', () => {
  const view = buildAdvicePresentation({
    action: '回调再买',
    actionPlan: '先等待，不追高',
    buyZone: '138.39~140.00元',
    watchPrice: '回踩138.39~140.00元企稳，或放量站上145.47元再评估',
    targetPrice: 160,
    stopPrice: 127.88,
    nextOpenPlan: '高开接近145.47元不追，回踩买入区再行动',
    futurePlan: '后续放量站上145.47元再重新评估突破跟进',
  })

  assert.deepEqual(
    view.levels.map((item) => [item.key, item.value]),
    [
      ['entry', '138.39~140.00元'],
      ['target', '160'],
      ['stop', '127.88'],
    ],
  )
  assert.deepEqual(
    view.planSteps.map((item) => item.label),
    ['下个开盘', '后续路径'],
  )
})

test('被阻断的买入计划不把现价冒充买入价且只展示已验证观察价', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    actionPlan: '站上10.8元且资金确认后重新判断',
    watchPrice: 10.8,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision.wait',
      mode: 'buy_advice',
      action: 'WATCH',
      actionLabel: '观望',
      actionability: 'BLOCKED',
      blockedReasons: ['量价与资金确认不足'],
      prices: {
        reference: 10,
        current: 10,
        watch: 10.8,
        stop: null,
        target: null,
      },
      quantity: { lots: 0 },
      costs: { estimatedNetAmount: 0 },
      priceContract: {
        schemaVersion: 'advice-price-contract.v1',
        validationStatus: 'VERIFIED',
      },
    },
  })

  assert.deepEqual(view.levels.map((item) => [
    item.key,
    item.value,
  ]), [['watch', '10.8']])
  assert.equal(view.observationOnly, true)
})

test('未持仓观望同时展示回踩与突破观察位', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    actionPlan: '回踩96元企稳或放量站上105元后重新判断',
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      currentPrice: 100,
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'watch_pullback',
        field: 'pullbackWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '回踩观察',
        price: 96,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
        currentDistancePct: 4,
      }, {
        key: 'watch_breakout',
        field: 'breakoutWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '突破观察',
        price: 105,
        direction: 'GTE',
        status: 'PENDING',
        strict: true,
        currentDistancePct: 5,
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ANY', conditions: [], allMet: false },
    },
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionability: 'WATCH',
      prices: { current: 100 },
    },
  })

  assert.deepEqual(view.levels.map((item) => [
    item.key,
    item.label,
    item.value,
    item.distanceText,
  ]), [
    ['watch_pullback', '回踩观察', '96', '距现价-4.0%'],
    ['watch_breakout', '突破观察', '105', '距现价+5.0%'],
  ])
  assert.equal(
    view.operationGuide.now,
    '暂不买入，不挂单、不追涨。',
  )
  assert.deepEqual(
    view.operationGuide.steps.map((item) => item.label),
    ['回踩路径', '突破路径'],
  )
  assert.match(
    view.operationGuide.steps[0].text,
    /96元.*复核确认前不买入/,
  )
  assert.match(
    view.operationGuide.steps[1].text,
    /105元.*确认前不追涨/,
  )
})

test('未持仓观望不展示止损目标并使用直观观察文案', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    actionPlan: '等待放量站上17.12元后重新判断',
    timing: '放量站上17.12元后重新判断',
    invalidation: '跌破15.23元且收不回则取消关注',
    watchPrice: 17.12,
    stopPrice: 15.23,
    targetPrice: 18.6,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision.wait-clean',
      mode: 'buy_advice',
      action: 'WATCH',
      actionLabel: '观望',
      actionability: 'WATCH',
      trigger: '放量站上17.12元后重新判断',
      invalidation: '跌破15.23元且收不回则取消关注',
      prices: {
        reference: 16.2,
        current: 16.2,
        watch: 17.12,
        stop: 15.23,
        target: 18.6,
      },
      quantity: { lots: 0 },
      costs: { estimatedNetAmount: 0 },
    },
  })

  assert.equal(view.observationOnly, true)
  assert.deepEqual(view.levels.map((item) => item.label), ['观察价'])
  assert.equal(view.trigger.title, '观察与重新判断')
  assert.equal(view.trigger.conditionLabel, '重新判断')
  assert.equal(view.trigger.invalidationLabel, '取消关注')
})

test('未持仓观望缺少可靠观察价时明确显示等待重新定价', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    actionPlan: '当前证据不足，暂不买入',
    stopPrice: 15.23,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision.wait-no-price',
      mode: 'buy_advice',
      action: 'WATCH',
      actionLabel: '观望',
      actionability: 'WATCH',
      prices: {
        reference: 16.2,
        current: 16.2,
        watch: null,
        stop: 15.23,
        target: null,
      },
      quantity: { lots: 0 },
      costs: { estimatedNetAmount: 0 },
    },
  })

  assert.deepEqual(view.levels, [{
    key: 'watch',
    label: '观察价',
    value: '等待重新定价',
    tone: 'muted',
  }])
})

test('短线内核改写模型动作时首屏解释原因而非只显示观望', () => {
  const view = buildAdvicePresentation({
    action: '立即买入',
    title: '模型建议追涨',
    reviewTrigger: '回踩10元后重新评估',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      mode: 'buy_advice',
      requestedAction: 'BUY',
      governedAction: 'WATCH',
      action: 'WATCH',
      actionLabel: '观望',
      actionability: 'WATCH',
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        overridden: true,
        reasons: [
          '价格位置过热，禁止追涨',
          '主力资金尚未确认流入',
        ],
        nextReviewTrigger: '回踩10元后重新评估',
      },
      trigger: '回踩10元后重新评估',
      quantity: { lots: 0 },
      prices: {
        current: 10.8,
        observations: [],
      },
      costs: { estimatedNetAmount: 0 },
      blockedReasons: [],
    },
  })

  assert.equal(view.verdict.action, '观望')
  assert.equal(
    view.verdict.title,
    '短线条件未确认，暂不操作',
  )
  assert.equal(
    view.operationGuide.now,
    '暂不买入，不挂单、不追涨。',
  )
  assert.equal(
    view.operationGuide.steps[0].label,
    '为何不操作',
  )
  assert.match(
    view.operationGuide.steps[0].text,
    /禁止追涨.*主力资金尚未确认/,
  )
})

test('默认核心依据压缩为可扫读摘要而完整原文仍保留在建议数据中', () => {
  const longText = `量化方向偏多，${'但仍需等待价格确认。'.repeat(30)}`
  const view = buildAdvicePresentation({
    quantNote: longText,
    fundNote: '资金流向偏强。',
  })

  assert.ok(view.evidence[0].text.length <= 181)
  assert.match(view.evidence[0].text, /…$/)
  assert.equal(longText.length > view.evidence[0].text.length, true)
})

test('军师主视图提供紧凑短线窗口而不暴露内部战术枚举', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    title: '等待突破确认',
    shortHorizon: '1-3个交易日',
    edge: '板块前排且主力承接',
    crowdingRisk: '当前位置偏高，防冲高回落',
    catalystWindow: '催化仍新鲜，等待量价确认',
    reviewTrigger: '突破10.8元或资金转弱时重评',
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      timing: { state: 'WAIT_BREAKOUT' },
    },
  })

  assert.deepEqual(view.tactical, {
    stage: '',
    horizon: '1-3个交易日',
    edge: '板块前排且主力承接',
    risk: '当前位置偏高，防冲高回落',
    catalyst: '催化仍新鲜，等待量价确认',
    reviewTrigger: '突破10.8元或资金转弱时重评',
  })
  assert.doesNotMatch(JSON.stringify(view.tactical), /WAIT_BREAKOUT/)
})

test('军师展示契约去除重复依据并兼容持仓建议旧字段', () => {
  const view = buildAdvicePresentation({
    stance: '持有',
    headline: '守住支撑继续持有',
    nextAction: '守住9.80元继续持有，跌破再减仓',
    opQty: '无需操作',
    addPrice: 9.8,
    reducePrice: 10.8,
    stopPrice: 9.5,
    targetPrice: 10.8,
    timing: '守住9.80元',
    techNote: '均线仍为多头排列',
    fundNote: '均线仍为多头排列',
    quantNote: '量化方向偏多',
  })

  assert.equal(view.verdict.action, '持有')
  assert.equal(view.verdict.title, '守住支撑继续持有')
  assert.equal(view.execution.instruction, '守住9.80元继续持有，跌破再减仓')
  assert.equal(view.levels.length, 3)
  assert.equal(view.evidence.length, 2)
  assert.deepEqual(
    view.evidence.map((item) => item.label),
    ['量化', '资金'],
  )
})

test('军师默认展示所选模型、实际窗口与V2.1实验风险', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    title: '等待盘中信号确认',
    quantContext: {
      selectedModelVersion: 'v2.1',
      effectiveModelVersion: 'v2.1',
      runtimeModelVersion: 'v2.1-intraday',
      modelLabel: '分钟 Transformer V2.1（盘中实验）',
      horizon: '未来30分钟',
      asOf: '2026-08-12 10:30:00',
      experimental: true,
      reliability: {
        productionGatePassed: false,
        thresholdPct: 58,
        balancedAccuracyPct: {
          next30m: 53.92,
          sessionClose: 54.58,
        },
      },
    },
  })

  assert.deepEqual(view.model, {
    label: '分钟 Transformer V2.1（盘中实验）',
    horizon: '未来30分钟',
    asOf: '2026-08-12 10:30:00',
    experimental: true,
    fallback: null,
    reliabilityText: '30分钟 53.92% · 收盘 54.58% · 门槛 58%',
  })
})

test('军师模型摘要直接展示本次采用的生产模型次日预测', () => {
  const view = buildAdvicePresentation({
    action: '持有',
    title: '等待次日确认',
    quantContext: {
      selectedModelVersion: 'default',
      effectiveModelVersion: 'default',
      runtimeModelVersion: '',
      modelLabel: '当前生产模型',
      horizon: 'next5TradingDays',
      asOf: '2026-08-19',
      experimental: false,
      fallback: null,
      reliability: null,
      nextTradeDayForecast: {
        targetDate: '2026-08-20',
        direction: '震荡',
        upProb: 49,
        expRet: -0.36,
        targetLow: 49.17,
        targetMid: 53.75,
        targetHigh: 58.08,
      },
    },
  })

  assert.equal(
    view.model.nextTradeDayText,
    '次日 08-20 · 震荡 · 上涨49% · 预期-0.36% · 49.17~58.08',
  )
})

test('决策计划v2优先提供最终动作、手数、费用和执行校验', () => {
  const view = buildAdvicePresentation({
    action: '立即买入',
    title: '模型建议买入',
    actionPlan: '买入10手',
    planQty: 10,
    planAmount: 10000,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision.demo',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'READY',
      asOf: '2026-08-21T02:30:00.000Z',
      validUntil: '2026-08-21T02:45:00.000Z',
      marketRegime: {
        regime: 'TREND_STRONG',
        label: '强势趋势',
        score: 76,
      },
      quantity: { lots: 5, requestedLots: 10 },
      prices: { reference: 10, stop: 9, target: 12 },
      currentWeightPct: 0,
      targetWeightPct: 5,
      deltaWeightPct: 5,
      risk: { maxLossAmount: 600, budgetPct: 0.6 },
      costs: {
        side: 'BUY',
        estimatedNetAmount: 5010,
        estimatedFees: 7.5,
      },
      blockedReasons: [],
      evidenceBasis: {
        state: 'PREVIOUS_CLOSE',
        label: '最近交易日完整数据',
        dataAsOf: '2026-08-21(周五)',
        phase: '休市(周末)',
        isLive: false,
      },
      evidenceIssues: [{
        source: 'quote',
        label: '个股行情',
        status: 'ERROR',
        reason: '接口返回 HTTP 401',
        impact: '无法确认当前价和价格时效',
        recovery: '行情接口恢复后重新生成',
      }],
      trigger: '回踩企稳',
      invalidation: '跌破9元',
    },
  })

  assert.equal(view.verdict.action, '买入')
  assert.equal(view.execution.quantity, '5手')
  assert.equal(view.execution.amount, '5010')
  assert.equal(view.execution.position, '0% → 5%')
  assert.match(view.execution.instruction, /买入5手/)
  assert.match(view.execution.instruction, /5手/)
  assert.doesNotMatch(view.execution.instruction, /10手/)
  assert.equal(
    view.operationGuide.now,
    '买入5手，参考10元；仅在核对价格和账户后人工执行。',
  )
  assert.deepEqual(
    view.operationGuide.steps.map((item) => item.label),
    ['执行条件', '退出纪律', '计划失效'],
  )
  assert.match(
    view.operationGuide.steps[1].text,
    /止损9元，目标12元/,
  )
  assert.equal(view.decisionPlan.actionability, 'READY')
  assert.equal(view.decisionPlan.strategyName, undefined)
  assert.deepEqual(view.decisionPlan.evidenceBasis, {
    state: 'PREVIOUS_CLOSE',
    label: '最近交易日完整数据',
    dataAsOf: '2026-08-21(周五)',
    phase: '休市(周末)',
    isLive: false,
  })
  assert.deepEqual(view.decisionPlan.evidenceIssues, [{
    source: 'quote',
    label: '个股行情',
    status: 'ERROR',
    reason: '接口返回 HTTP 401',
    impact: '无法确认当前价和价格时效',
    recovery: '行情接口恢复后重新生成',
  }])
  assert.match(view.decisionPlan.statusText, /证据、价格与账户风险检查均已通过/)
  assert.deepEqual(
    view.levels.map((item) => item.value),
    ['10', '12', '9'],
  )
})

test('短线试仓展示板块依据并明确只允许人工确认', () => {
  const view = buildAdvicePresentation({
    action: '小仓试错',
    title: '板块前排回踩试仓',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'MANUAL_PROBE',
      manualConfirmationOnly: true,
      quantity: { lots: 2 },
      prices: { reference: 10, stop: 9, target: 12 },
      costs: { estimatedNetAmount: 2005 },
      opportunity: {
        sectorName: '新能源车',
        stockRole: '总龙头',
      },
    },
  })

  assert.equal(view.verdict.action, '小仓试错')
  assert.match(view.execution.instruction, /人工确认/)
  assert.equal(view.decisionPlan.manualConfirmationOnly, true)
  assert.deepEqual(view.decisionPlan.opportunity, {
    sectorName: '新能源车',
    stockRole: '总龙头',
  })
})
