import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildActionProgress,
  buildAdviceActionView,
  buildHoldingCardDecisionView,
} from '../shared/adviceActionView.js'
import { planStore } from '../src/planStore.js'

test('止损触及但做T买回仓位受T加一锁定时卡片保留不可卖指令', () => {
  const view = buildHoldingCardDecisionView({
    advice: {
      action: '持有',
      opQty: '今日不可卖',
      actionPlan: '本轮做T已完成，买回1手今日T+1锁定、今日可卖0手；明天再按盘面操作',
      reducePrice: 56.39,
      stopPrice: 55.5,
    },
    hitStop: true,
    stopPrice: 55.5,
    targetPrice: 56.39,
    t1Status: { liveQty: 1, boughtToday: 1, sellableToday: 0 },
    nextTradeDay: '2026-08-20(周四)',
  })

  assert.equal(view.kind, 'hold')
  assert.equal(view.action, '持有')
  assert.equal(view.quantity, '')
  assert.match(view.instruction, /本轮做T已完成/)
  assert.doesNotMatch(view.instruction, /按纪律确认后退出/)
})

test('卡片优先遵从军师已持久化的今日不可卖约束', () => {
  const view = buildHoldingCardDecisionView({
    advice: {
      action: '持有',
      opQty: '今日不可卖',
      actionPlan: '本轮做T已完成，买回1手今日T+1锁定、今日可卖0手；明天再按盘面操作',
      reducePrice: 56.39,
      stopPrice: 55.5,
    },
    hitStop: true,
    stopPrice: 55.5,
    targetPrice: 56.39,
    // 模拟浏览器端旧账本暂时未识别已配对买回腿的锁定。
    t1Status: { liveQty: 1, boughtToday: 0, sellableToday: 1 },
    nextTradeDay: '2026-08-20(周四)',
  })

  assert.equal(view.action, '持有')
  assert.match(view.instruction, /今日可卖0手/)
  assert.doesNotMatch(view.instruction, /按纪律确认后退出/)
})

test('买入建议把买入价和首笔手数编译为同一动作视图', () => {
  const view = buildAdviceActionView({
    action: '回调再买',
    actionPlan: '回踩61.20元企稳后买入2手',
    buyPrice: 61.2,
    planQty: 2,
    stopPrice: 58.8,
    targetPrice: 67.5,
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'buy')
  assert.equal(view.quantity, '2手')
  assert.deepEqual(view.levels[0], {
    key: 'entry',
    label: '买入执行价',
    price: 61.2,
    tone: 'buy',
    active: true,
  })
  assert.deepEqual(view.trigger, {
    direction: 'lte',
    price: 61.2,
    label: '买入位',
    metricLabel: '买入准备',
  })
})

test('观望建议不把远端关注价展示成候选卡主价位', () => {
  const view = buildAdviceActionView({
    action: '观望',
    actionPlan: '站稳63.50元并放量后再评估',
    buyPrice: 61.2,
    planQty: 0,
    watchPrice: 63.5,
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'wait')
  assert.equal(view.quantity, '')
  assert.deepEqual(view.levels, [])
  assert.equal(view.trigger.direction, 'inactive')
  assert.equal(view.trigger.price, null)
  assert.equal(view.trigger.stateLabel, '保持观望')
  assert.equal(view.trigger.detailLabel, '等待量价确认')
  assert.equal(view.trigger.metricLabel, '暂不下单')
})

test('观望建议缺少结构化关注价时仍显示暂不下单状态', () => {
  const view = buildAdviceActionView({
    action: '观望',
    actionPlan: '量能与趋势尚未确认，等待站稳压力位再评估',
    planQty: 0,
  }, { mode: 'buy_advice' })

  assert.deepEqual(view.levels, [])
  assert.deepEqual(view.trigger, {
    direction: 'inactive',
    price: null,
    label: '等待确认',
    stateLabel: '保持观望',
    detailLabel: '等待量价确认',
    metricLabel: '暂不下单',
  })
})

test('加仓建议展示加仓点而不是通用买入点', () => {
  const view = buildAdviceActionView({
    action: '加仓',
    actionPlan: '回踩10.20元企稳后加仓2手',
    buyPrice: 10.5,
    addPrice: 10.2,
    reducePrice: 11.4,
    stopPrice: 9.8,
    opQty: '加仓2手',
  }, { mode: 'hold_advice' })

  assert.equal(view.kind, 'add')
  assert.equal(view.quantity, '加仓2手')
  assert.equal(view.levels[0].key, 'add')
  assert.equal(view.levels[0].label, '加仓执行价')
  assert.equal(view.levels[0].price, 10.2)
  assert.equal(view.levels[0].active, true)
  assert.equal(view.trigger.direction, 'lte')
  assert.equal(view.trigger.price, 10.2)
})

test('减仓建议以减仓点和向上触发进度为主', () => {
  const view = buildAdviceActionView({
    action: '减仓',
    actionPlan: '反弹到11.40元减仓1手',
    addPrice: 10.2,
    reducePrice: 11.4,
    stopPrice: 9.8,
    opQty: '减仓1手',
  }, { mode: 'hold_advice' })

  assert.equal(view.kind, 'reduce')
  assert.equal(view.levels[0].key, 'reduce')
  assert.equal(view.levels[0].active, true)
  assert.equal(view.trigger.direction, 'gte')
  assert.equal(view.trigger.metricLabel, '减仓准备')
})

test('跌破型减仓明确显示触发线并按向下条件判断', () => {
  const view = buildAdviceActionView({
    action: '减仓',
    actionPlan: '触及31.82元且30至60分钟不能收回，卖出1手',
    reducePrice: 31.82,
    stopPrice: 31.82,
    opQty: '减仓1手',
  }, { mode: 'hold_advice' })

  assert.equal(view.levels[0].label, '减仓触发线')
  assert.equal(view.trigger.direction, 'lte')
  assert.equal(view.trigger.metricLabel, '减仓条件')
  assert.equal(
    buildActionProgress(view.trigger, 33.24).stateLabel,
    '等待跌破',
  )
})

test('持有建议把加仓和减仓价降级为观察边界并生成区间进度', () => {
  const view = buildAdviceActionView({
    action: '持有',
    actionPlan: '守住10.20元继续持有，反弹11.40元再评估',
    addPrice: 10.2,
    reducePrice: 11.4,
    stopPrice: 9.8,
    opQty: '无需操作',
  }, { mode: 'hold_advice' })

  assert.equal(view.kind, 'hold')
  assert.equal(view.quantity, '')
  assert.deepEqual(
    view.levels.map(({ key, label, active }) => ({ key, label, active })),
    [
      { key: 'add', label: '回踩观察', active: false },
      { key: 'reduce', label: '反弹观察', active: false },
      { key: 'stop', label: '止损线', active: false },
    ],
  )
  assert.deepEqual(view.trigger, {
    direction: 'range',
    low: 10.2,
    high: 11.4,
    label: '观察区间',
    metricLabel: '继续持有',
  })
})

test('持有建议缺少回踩价时使用止损线补全观察区间', () => {
  const view = buildAdviceActionView({
    action: '持有',
    actionPlan: '持有1手，反弹67.87元再评估，跌破59.31元清仓',
    reducePrice: 67.87,
    stopPrice: 59.31,
    opQty: '无需操作',
  }, { mode: 'hold_advice' })

  assert.deepEqual(
    view.levels.map(({ key, label, price }) => ({ key, label, price })),
    [
      { key: 'reduce', label: '反弹观察', price: 67.87 },
      { key: 'stop', label: '止损线', price: 59.31 },
    ],
  )
  assert.deepEqual(view.trigger, {
    direction: 'range',
    low: 59.31,
    high: 67.87,
    label: '观察区间',
    metricLabel: '继续持有',
  })
})

test('研究级买入计划保留价格研究但不进入可执行状态', () => {
  const view = buildAdviceActionView({
    action: '立即买入',
    buyPrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    planQty: 5,
    actionPlan: '立即买入5手',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'RESEARCH_ONLY',
      quantity: { lots: 3 },
      prices: { reference: 10, stop: 9, target: 12 },
    },
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'buy')
  assert.equal(view.actionable, false)
  assert.equal(view.quantity, '3手')
  assert.equal(view.trigger.price, 10)
})

test('被决策内核阻断的买入建议统一降级为观望', () => {
  const view = buildAdviceActionView({
    action: '立即买入',
    buyPrice: 10,
    planQty: 5,
    actionPlan: '立即买入5手',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionLabel: '观望',
      actionability: 'BLOCKED',
      quantity: { lots: 0 },
      prices: { reference: 10, stop: 9, target: 12 },
      blockedReasons: ['策略入场条件未通过'],
    },
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'wait')
  assert.equal(view.actionable, false)
  assert.equal(view.quantity, '')
  assert.equal(view.trigger.direction, 'inactive')
})

test('动作进度按买入向下、减仓向上和持有区间分别计算', () => {
  const buy = buildActionProgress({
    direction: 'lte',
    price: 61.2,
    label: '买入位',
    metricLabel: '买入准备',
  }, 65.4)
  const reduce = buildActionProgress({
    direction: 'gte',
    price: 11.4,
    label: '减仓位',
    metricLabel: '减仓准备',
  }, 10.8)
  const hold = buildActionProgress({
    direction: 'range',
    low: 10.2,
    high: 11.4,
    label: '观察区间',
    metricLabel: '继续持有',
  }, 10.8)
  const reached = buildActionProgress({
    direction: 'gte',
    price: 11.4,
    label: '减仓位',
    metricLabel: '减仓准备',
  }, 11.5)

  assert.equal(buy.tone, 'buy')
  assert.match(buy.label, /距买入位 6\.9%/)
  assert.equal(buy.score, 14.2)
  assert.equal(buy.stateLabel, '等待回踩')
  assert.equal(reduce.tone, 'sell')
  assert.match(reduce.label, /距减仓位 5\.3%/)
  assert.equal(reduce.score, 34.2)
  assert.equal(reduce.stateLabel, '等待反弹')
  assert.equal(hold.tone, 'range')
  assert.equal(hold.label, '现价位于区间中部')
  assert.equal(hold.score, 50)
  assert.equal(hold.stateLabel, '区间内持有')
  assert.equal(reached.reached, true)
  assert.equal(reached.stateLabel, '已到减仓位')
  assert.equal(reached.currentPrice, 11.5)
})

test('候选转为观望时只撤下系统买点预警', () => {
  planStore.setData({
    plan: [{
      code: '600001',
      name: '测试股票',
      alertSyncedPrice: 10.2,
    }],
    holding: [],
    closed: [],
    alerts: [
      { id: 'auto', code: '600001', candCode: '600001', value: 10.2 },
      { id: 'manual', code: '600001', type: 'price', value: 11 },
    ],
  })

  planStore.clearCandBuyAlert('600001')

  const state = planStore.get()
  assert.deepEqual(state.alerts.map((item) => item.id), ['manual'])
  assert.equal(state.plan[0].alertSyncedPrice, null)
})
