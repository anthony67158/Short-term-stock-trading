import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAdvicePresentation,
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
  })
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
