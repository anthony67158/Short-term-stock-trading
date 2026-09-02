import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionImportance,
  buildActionProgress,
  buildAdviceActionView,
  buildHoldingCardDecisionView,
  entryConvictionView,
} from '../shared/adviceActionView.js'
import {
  advicePlanSyncPatch,
  planStore,
} from '../src/planStore.js'
import { holdingAddReviewPlan } from '../shared/holdingFollowUp.js'

test('主结论按硬风险、立即执行、条件计划、持有和观望分级', () => {
  assert.equal(
    actionImportance({ kind: 'sell', action: '止损' }),
    'critical',
  )
  assert.equal(
    actionImportance({ kind: 'buy', action: '现在买入' }),
    'execute',
  )
  assert.equal(
    actionImportance({ kind: 'reduce', action: '止盈' }),
    'execute',
  )
  assert.equal(
    actionImportance({
      kind: 'wait',
      action: '次日条件买入',
      deferred: true,
    }),
    'ready',
  )
  assert.equal(
    actionImportance({
      kind: 'wait',
      action: '开盘后条件试仓',
      deferred: true,
    }),
    'conditional',
  )
  assert.equal(
    actionImportance({ kind: 'hold', action: '持有' }),
    'steady',
  )
  assert.equal(
    actionImportance({ kind: 'wait', action: '继续观望' }),
    'watch',
  )
})

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
  assert.equal(view.action, '继续持有')
  assert.equal(view.quantity, '')
  assert.match(view.instruction, /本轮做T已完成/)
  assert.doesNotMatch(view.instruction, /按纪律确认后退出/)
  assert.equal(view.levels[0].label, '反弹减仓观察')
  const progress = buildActionProgress(view.trigger, 57)
  assert.equal(progress.stateLabel, '已到减仓观察位')
  assert.equal(
    progress.reachedHint,
    '今日可卖0手，2026-08-20(周四)盘中复核减仓',
  )
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

  assert.equal(view.action, '继续持有')
  assert.match(view.instruction, /今日可卖0手/)
  assert.doesNotMatch(view.instruction, /按纪律确认后退出/)
})

test('持仓计划等待新证据时显示持有而不是未持仓语义观望', () => {
  const view = buildHoldingCardDecisionView({
    advice: {
      action: '观望',
      actionPlan:
        '下午连续竞价仅观察，不加仓、不做T；今日可卖0手，现有持仓受T+1约束不可卖出。',
      stopPrice: 47.01,
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'WATCH',
        actionLabel: '观望',
        actionability: 'WATCH',
        quantity: { lots: 0 },
        prices: {
          reference: 53.58,
          stop: 47.01,
          target: null,
        },
      },
    },
    t1Status: {
      liveQty: 1,
      boughtToday: 1,
      sellableToday: 0,
    },
  })

  assert.equal(view.kind, 'hold')
  assert.equal(view.action, '继续持有')
  assert.match(view.instruction, /今日可卖0手/)
})

test('自动跟随建议时清除新建议已经取消的旧止盈价', () => {
  assert.deepEqual(advicePlanSyncPatch({
    tp: 51.65,
    sl: 50.89,
    tpManual: false,
    slManual: false,
  }, {
    tp: null,
    sl: 50.89,
  }), {
    tp: null,
  })

  assert.deepEqual(advicePlanSyncPatch({
    tp: 51.65,
    sl: 50.89,
    tpManual: true,
    slManual: false,
  }, {
    tp: null,
    sl: 50.89,
  }), {})
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
    label: '买入价',
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

test('立即买入状态明确展示当前可执行价格而不是观察条件', () => {
  const view = buildAdviceActionView({
    action: '立即买入',
    buyPrice: 10.02,
    stopPrice: 9.7,
    targetPrice: 10.8,
    planQty: 3,
    actionPlan: '现价附近买入3手',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'READY',
      manualConfirmationOnly: false,
      quantity: { lots: 3 },
      prices: {
        reference: 10.02,
        stop: 9.7,
        target: 10.8,
      },
    },
  }, { mode: 'buy_advice', currentPrice: 10.02, executionOpen: true })

  assert.equal(view.action, '现在买入')
  assert.equal(view.actionable, true)
  assert.equal(view.manualOnly, false)
  assert.equal(view.quantity, '3手')
  assert.equal(view.levels[0].label, '买入价')
  assert.equal(view.levels[0].price, 10.02)
})

test('休市时旧买入建议在卡片上降级为下一交易时段观察', () => {
  const view = buildAdviceActionView({
    action: '立即买入',
    actionPlan: '放量站上15.69元买入2手',
    buyPrice: 15.69,
    planQty: 2,
    stopPrice: 15.33,
    targetPrice: 17.16,
  }, {
    mode: 'buy_advice',
    currentPrice: 15.44,
    executionOpen: false,
  })

  assert.equal(view.kind, 'wait')
  assert.equal(view.action, '下一交易时段再判断')
  assert.equal(view.actionable, false)
  assert.equal(view.quantity, '')
  assert.deepEqual(view.levels.map((item) => [
    item.key,
    item.label,
    item.price,
  ]), [
    ['watch_breakout', '突破观察', 15.69],
  ])
  assert.match(view.instruction, /高于收盘价15\.44元/)
  assert.match(view.instruction, /不是买入价/)
  assert.equal(view.trigger.direction, 'inactive')
})

test('休市观望建议关闭系统推荐买入但保留次日条件预案', () => {
  const view = buildAdviceActionView({
    action: '观望',
    actionPlan: '下一交易时段盘中，等待回踩15.2元后复核',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionability: 'WATCH',
      actionPolicy: {
        executionOpen: false,
        riskTier: 'PROBE',
        nextSessionPlan: {
          action: 'PROBE',
          actionLabel: '小仓试仓',
          session: 'NEXT_TRADING_DAY',
          sessionLabel: '下一交易日盘中',
          maxPositionPct: 5,
          manualConfirmationOnly: true,
          requiresLiveReview: true,
          trigger: '下一交易日盘中，回踩15.2元确认承接后重新评估',
        },
      },
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      levels: [{
        key: 'watch_pullback',
        price: 15.2,
        direction: 'LTE',
        strict: true,
        basis: 'technical.ma5',
      }],
    },
  }, {
    mode: 'buy_advice',
    currentPrice: 15.44,
    executionOpen: false,
  })

  assert.equal(view.action, '次日条件试仓')
  assert.equal(view.quantityLabel, '仓位≤5%')
  assert.equal(view.commandLabel, '条件计划')
  assert.equal(view.displayTone, 'buy')
  assert.equal(view.detailActionLabel, '查看次日预案')
  assert.equal(view.deferred, true)
  assert.equal(view.actionable, false)
  assert.equal(view.levels[0].basisLabel, '5日均线')
  assert.equal(view.trigger.stateLabel, '当前休市')
  assert.equal(view.trigger.detailLabel, '到价后确认买点')
  assert.equal(view.trigger.metricLabel, '条件试仓')
  assert.equal(
    view.cardInstruction,
    '下一交易日盘中，回踩15.2元确认承接后重新评估',
  )
  assert.match(view.instruction, /回踩15\.2元确认承接/)
  assert.match(view.instruction, /方向已通过/)
  assert.match(view.instruction, /确认通过后给出具体买入价和手数/)
})

test('下一交易日开盘后旧休市建议仍需先复核不能直接恢复买入', () => {
  const view = buildAdviceActionView({
    action: '立即买入',
    buyPrice: 15.2,
    planQty: 2,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionability: 'READY',
      actionPolicy: { executionOpen: false },
      evidenceBasis: {
        isLive: false,
        phase: '盘后(已收盘)',
      },
      quantity: { lots: 2 },
      prices: {
        reference: 15.2,
        current: 15.44,
        stop: 14.6,
        target: 16.5,
      },
    },
  }, {
    mode: 'buy_advice',
    currentPrice: 15.5,
    executionOpen: true,
  })

  assert.equal(view.action, '下一交易时段再判断')
  assert.equal(view.actionable, false)
  assert.match(view.instruction, /建议基于休市快照/)
})

test('下一交易日开盘后休市试仓预案进入盘中复核而不是退回笼统观望', () => {
  const view = buildAdviceActionView({
    action: '观望',
    actionPlan: '下一交易日盘中小仓试仓预案',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionability: 'WATCH',
      actionPolicy: {
        executionOpen: false,
        riskTier: 'PROBE',
        nextSessionPlan: {
          action: 'PROBE',
          session: 'NEXT_TRADING_DAY',
          maxPositionPct: 5,
          trigger: '下一交易日盘中，回踩15.2元确认承接后重新评估',
        },
      },
      evidenceBasis: {
        isLive: false,
        phase: '盘后(已收盘)',
      },
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      levels: [{
        key: 'watch_pullback',
        price: 15.2,
        direction: 'LTE',
        strict: true,
      }],
    },
  }, {
    mode: 'buy_advice',
    currentPrice: 15.3,
    executionOpen: true,
  })

  assert.equal(view.action, '盘中条件试仓')
  assert.equal(view.shortHorizon, '方向已通过 · 待时机确认')
  assert.equal(view.actionable, false)
  assert.equal(view.trigger.stateLabel, '试仓条件待复核')
  assert.equal(view.trigger.metricLabel, '确认后给买入价')
})

test('持仓卡在休市时显示下一交易日条件加仓而不是盘中持有在看', () => {
  const view = buildAdviceActionView({
    action: '持有',
    actionPlan: '当前持有观察',
    addPrice: 15.2,
    reducePrice: 16.5,
    stopPrice: 14.7,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'HOLD',
      actionability: 'WATCH',
      actionPolicy: {
        executionOpen: false,
        riskTier: 'PROBE',
        nextSessionPlan: {
          action: 'PROBE_ADD',
          session: 'NEXT_TRADING_DAY',
          maxPositionPct: 5,
          trigger: '下一交易日盘中，回踩15.2元确认承接后重新评估',
        },
      },
      evidenceBasis: {
        isLive: false,
        phase: '盘后(已收盘)',
      },
    },
  }, {
    mode: 'hold_advice',
    currentPrice: 15.44,
    executionOpen: false,
  })

  assert.equal(view.action, '次日条件加仓')
  assert.equal(view.quantityLabel, '仓位≤5%')
  assert.equal(view.commandLabel, '条件计划')
  assert.equal(view.actionable, false)
  assert.equal(view.trigger.stateLabel, '当前休市')
})

test('价位卡展示可核验的数据来源而不是笼统建议', () => {
  const view = buildAdviceActionView({
    action: '回调再买',
    buyPrice: 14.18,
    planQty: 2,
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      levels: [{
        key: 'entry',
        field: 'buyPrice',
        price: 14.18,
        strict: true,
        basis: 'technical.ma20',
      }],
    },
  }, {
    mode: 'buy_advice',
    currentPrice: 15.44,
    executionOpen: true,
  })

  assert.equal(view.levels[0].basisLabel, '20日均线')
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
  assert.equal(view.trigger.stateLabel, '量价条件尚未满足')
  assert.equal(view.trigger.detailLabel, '出现新证据后重新评估')
  assert.equal(view.trigger.metricLabel, '未触发不买')
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
    label: '条件尚未确认',
    stateLabel: '量价条件尚未满足',
    detailLabel: '出现新证据后重新评估',
    metricLabel: '未触发不买',
  })
})

test('候选卡只展示一个主观察路径并明确后续动作', () => {
  const view = buildAdviceActionView({
    action: '观望',
    actionPlan: '等待回踩96元企稳，或放量突破105元后重新评估',
    shortHorizonTactical: {
      timing: { state: 'WAIT_BREAKOUT' },
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      levels: [{
        key: 'watch_pullback',
        label: '回踩观察',
        price: 96,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
      }, {
        key: 'watch_breakout',
        label: '突破观察',
        price: 105,
        direction: 'GTE',
        status: 'PENDING',
        strict: true,
      }],
    },
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'wait')
  assert.equal(view.action, '突破后再判断')
  assert.equal(view.commandLabel, '唯一条件')
  assert.equal(view.actionable, false)
  assert.deepEqual(view.levels.map((item) => [
    item.key,
    item.label,
    item.price,
  ]), [
    ['watch_breakout', '突破观察', 105],
  ])
  assert.match(view.instruction, /只看105元/)
  assert.match(view.instruction, /未放量或跌回105元下方不买/)
  assert.doesNotMatch(view.instruction, /96元/)
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
    '跌破条件监控中',
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
      { key: 'add', label: '回踩加仓观察', active: false },
      { key: 'reduce', label: '反弹减仓观察', active: false },
      { key: 'stop', label: '止损价', active: false },
    ],
  )
  assert.deepEqual(view.trigger, {
    direction: 'range',
    low: 10.2,
    high: 11.4,
    lowKey: 'add',
    highKey: 'reduce',
    lowLabel: '加仓观察位',
    highLabel: '减仓观察位',
    label: '观察区间',
    metricLabel: '继续持有',
  })
})

test('持有建议把战术回踩与突破价编译成双路径加仓复核', () => {
  const view = buildAdviceActionView({
    action: '持有',
    actionPlan: '今日继续持有',
    stopPrice: 50.89,
    shortHorizonTactical: {
      timing: {
        pullbackPrice: 50.94,
        breakoutPrice: 52.06,
      },
      actionPolicy: {
        riskTier: 'NONE',
        canIncreaseRisk: false,
        reasons: ['成交额不足', '量化尚未强确认'],
      },
    },
  }, { mode: 'hold_advice' })

  assert.deepEqual(
    view.levels.map(({ key, label, price }) => ({ key, label, price })),
    [
      {
        key: 'holding_add_pullback',
        label: '回踩加仓复核',
        price: 50.94,
      },
      {
        key: 'holding_add_breakout',
        label: '突破加仓复核',
        price: 52.06,
      },
      { key: 'stop', label: '止损价', price: 50.89 },
    ],
  )
  assert.equal(view.trigger.direction, 'review_paths')
  assert.match(view.instruction, /本轮不直接加仓：成交额不足；量化尚未强确认/)
  const progress = buildActionProgress(view.trigger, 52.16)
  assert.equal(progress.reached, true)
  assert.equal(progress.reachedKey, 'holding_add_breakout')
  assert.equal(progress.stateLabel, '突破加仓复核已到')
  assert.equal(progress.reachedHint, '已到价，正在提交复核')
})

test('持仓到价终局结论不再生成后续加仓复核路径', () => {
  const view = buildAdviceActionView({
    action: '持有',
    actionPlan: '维持持有：本次触发结束',
    reviewDecision: {
      schemaVersion: 'triggered-review-decision.v1',
      terminal: true,
      outcome: '维持持有',
    },
    shortHorizonTactical: {
      timing: {
        pullbackPrice: 50.94,
        breakoutPrice: 52.06,
      },
      actionPolicy: {
        riskTier: 'PROBE',
      },
    },
  }, { mode: 'hold_advice' })

  assert.equal(view.action, '本次不加仓、不减仓')
  assert.equal(view.commandLabel, '复核结论')
  assert.deepEqual(view.levels, [])
  assert.match(view.instruction, /继续持有现有仓位/)
  assert.doesNotMatch(view.instruction, /维持持有/)
})

test('弱市条件加仓复核沿用3%仓位上限', () => {
  const followUp = holdingAddReviewPlan({
    action: '持有',
    shortHorizonTactical: {
      timing: {
        pullbackPrice: 50.94,
        breakoutPrice: 52.06,
      },
      actionPolicy: {
        riskTier: 'PROBE',
        maxPositionPct: 3,
      },
    },
  })

  assert.equal(followUp.reviewIntent.mode, 'ENTRY_CONFIRMATION')
  assert.equal(followUp.reviewIntent.plannedAction, 'PROBE_ADD')
  assert.equal(followUp.reviewIntent.maxPositionPct, 3)
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
      { key: 'reduce', label: '反弹减仓观察', price: 67.87 },
      { key: 'stop', label: '止损价', price: 59.31 },
    ],
  )
  assert.deepEqual(view.trigger, {
    direction: 'range',
    low: 59.31,
    high: 67.87,
    lowKey: 'stop',
    highKey: 'reduce',
    lowLabel: '止损位',
    highLabel: '减仓观察位',
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

test('人工试仓计划保留短线买点但明确只允许手动确认', () => {
  const view = buildAdviceActionView({
    action: '小仓试错',
    buyPrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    planQty: 5,
    actionPlan: '回踩10元企稳后小仓试错5手',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'MANUAL_PROBE',
      manualConfirmationOnly: true,
      quantity: { lots: 5 },
      prices: { reference: 10, stop: 9, target: 12 },
    },
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'buy')
  assert.equal(view.action, '小仓试错')
  assert.equal(view.actionable, true)
  assert.equal(view.manualOnly, true)
  assert.equal(view.quantity, '5手')
  assert.match(view.instruction, /人工确认/)
  assert.equal(view.levels[0].label, '买入价')
  assert.equal(view.levels[0].price, 10)
  assert.equal(view.trigger.metricLabel, '买入准备')
})

test('就绪计划带人工确认标记时仍显示为小仓试错', () => {
  const view = buildAdviceActionView({
    action: '立即买入',
    actionPlan: '回踩10元企稳后买入',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'READY',
      manualConfirmationOnly: true,
      quantity: { lots: 3 },
      prices: { reference: 10, stop: 9, target: 12 },
    },
  }, { mode: 'buy_advice' })

  assert.equal(view.action, '小仓试错')
  assert.equal(view.manualOnly, true)
  assert.equal(view.actionable, true)
  assert.match(view.instruction, /人工确认/)
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
      blockedReasons: ['量价与资金确认不足'],
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
  assert.equal(buy.stateLabel, '回踩条件监控中')
  assert.equal(reduce.tone, 'sell')
  assert.match(reduce.label, /距减仓位 5\.3%/)
  assert.equal(reduce.score, 34.2)
  assert.equal(reduce.stateLabel, '反弹条件监控中')
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
      reviewSyncedPrice: 9.8,
      reviewSyncedPrices: {
        watch_pullback: 9.8,
        watch_breakout: 10.6,
      },
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
  assert.equal(state.plan[0].reviewSyncedPrice, null)
  assert.equal(state.plan[0].reviewSyncedPrices, null)
})

test('正式建仓计划向卡片输出仓位band与进场路线的强信号', () => {
  const conviction = entryConvictionView({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionability: 'READY',
      actionPolicy: {
        riskTier: 'FULL',
        entryRoute: 'BREAKOUT_MOMENTUM',
        positionBandPct: { min: 10, max: 20 },
        confirmations: ['主力资金确认', '技术面多头共振'],
      },
    },
  })

  assert.equal(conviction.tier, 'FULL')
  assert.equal(conviction.sizeLabel, '正式建仓')
  assert.equal(conviction.sizeValue, '10–20%')
  assert.equal(conviction.route, '放量突破确认')
  assert.deepEqual(conviction.confirmations, ['主力资金确认', '技术面多头共振'])
  assert.equal(conviction.tone, 'buy')
})

test('小仓试错计划输出仓位上限与试仓语义', () => {
  const conviction = entryConvictionView({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionability: 'MANUAL_PROBE',
      manualConfirmationOnly: true,
      actionPolicy: {
        riskTier: 'PROBE',
        entryRoute: null,
        maxPositionPct: 5,
        confirmations: ['主力资金确认'],
      },
    },
  })

  assert.equal(conviction.tier, 'PROBE')
  assert.equal(conviction.sizeLabel, '小仓试错')
  assert.equal(conviction.sizeValue, '≤5%')
  assert.equal(conviction.tone, 'probe')
})

test('观望或被阻断计划不产生进场强信号', () => {
  assert.equal(entryConvictionView({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionability: 'BLOCKED',
      actionPolicy: { riskTier: 'NONE' },
    },
  }), null)
  assert.equal(entryConvictionView({}), null)
})

test('旧观望数据已有完整建仓参数时归并为唯一待确认预案', () => {
  const advice = {
    action: '观望',
    actionPlan: '人工确认后以12.31元买入3手；跌破12.22元止损，目标13.50元，不追高补仓。',
    buyPrice: 12.31,
    planQty: 3,
    stopPrice: 12.22,
    targetPrice: 13.5,
    pullbackWatchPrice: 12.22,
    breakoutWatchPrice: 12.42,
  }
  const view = buildAdviceActionView(advice, {
    mode: 'buy_advice',
    currentPrice: 12.43,
  })

  assert.equal(view.kind, 'wait')
  assert.equal(view.action, '人工确认后建仓')
  assert.equal(view.commandLabel, '执行预案')
  assert.equal(view.quantity, '3手')
  assert.equal(view.actionable, false)
  assert.equal(view.manualOnly, true)
  assert.deepEqual(view.levels.map(({ key, label, price }) => ({
    key,
    label,
    price,
  })), [
    { key: 'entry', label: '拟买价', price: 12.31 },
    { key: 'stop', label: '止损价', price: 12.22 },
    { key: 'target', label: '目标价', price: 13.5 },
  ])
  assert.equal(view.trigger.stateLabel, '确认后可执行')
  assert.match(view.instruction, /12\.31元买入3手/)
})

test('买入到价终局结论在卡片直接显示放弃买入且不再展示观察价', () => {
  const view = buildAdviceActionView({
    action: '观望',
    title: '放弃买入',
    actionPlan: '放弃本次买入：原触发条件已经失效',
    reviewDecision: {
      schemaVersion: 'triggered-review-decision.v1',
      terminal: true,
      outcome: '放弃买入',
      operation: '不操作',
    },
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionability: 'WATCH',
      quantity: { lots: 0 },
      prices: { observations: [] },
    },
  }, { mode: 'buy_advice' })

  assert.equal(view.kind, 'wait')
  assert.equal(view.action, '放弃买入')
  assert.equal(view.commandLabel, '复核结论')
  assert.deepEqual(view.levels, [])
  assert.match(view.instruction, /原触发条件已经失效/)
  assert.equal(view.trigger.stateLabel, '放弃买入')
  assert.equal(view.trigger.detailLabel, '本次价格触发已结束')
  assert.equal(view.trigger.metricLabel, '不再复核原价')
})

test('一手持仓卡把减仓一手展示为二选一清仓路径', () => {
  const view = buildHoldingCardDecisionView({
    advice: {
      action: '减仓',
      opQty: '减仓1手',
      reducePrice: 40.22,
      stopPrice: 38.67,
      actionPlan: '主力流出且个股转弱，按纪律减仓1手',
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'REDUCE',
        actionLabel: '减仓',
        actionability: 'READY',
        quantity: { lots: 1, sellableLots: 1 },
        prices: {
          reference: 40.22,
          reduce: 40.22,
          stop: 38.67,
        },
      },
    },
    t1Status: {
      liveQty: 1,
      sellableToday: 1,
    },
  })

  assert.equal(view.kind, 'sell')
  assert.equal(view.action, '退出观察')
  assert.equal(view.quantity, '确认后清仓1手')
  assert.equal(view.actionable, false)
  assert.deepEqual(
    view.levels.map(({ key, label }) => ({ key, label })),
    [
      { key: 'reduce', label: '反弹清仓位' },
      { key: 'stop', label: '未执行兜底止损' },
    ],
  )
  assert.equal(view.trigger.price, 40.22)
  assert.match(view.cardInstruction, /观察约60秒/)
  assert.match(view.cardInstruction, /任一路径成交后.*失效/)
})

test('一手持仓实时触及止损时先进入短观察而不是立即清仓', () => {
  const view = buildHoldingCardDecisionView({
    advice: {
      action: '持有',
      reducePrice: 40.22,
      stopPrice: 38.67,
    },
    hitStop: true,
    stopPrice: 38.67,
    t1Status: {
      liveQty: 1,
      sellableToday: 1,
    },
  })

  assert.equal(view.action, '退出观察')
  assert.equal(view.quantity, '确认后清仓1手')
  assert.equal(view.actionable, false)
  assert.equal(view.trigger.price, 38.67)
  assert.equal(view.levels[0].label, '止损确认位')
  assert.match(view.instruction, /观察约20秒/)
})
