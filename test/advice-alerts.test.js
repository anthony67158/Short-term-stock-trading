import test from 'node:test'
import assert from 'node:assert/strict'

import { projectAdviceAlerts } from '../shared/adviceAlerts.js'

const now = 1786080000000
const ids = (() => {
  let n = 0
  return () => `alert_${++n}`
})()

test('云端买入建议会生成候选买点预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '600519', {
    name: '贵州茅台',
    buyPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.equal(data.alerts.length, 1)
  assert.deepEqual(data.alerts[0], {
    id: 'alert_1',
    enabled: true,
    createdAt: now,
    triggeredAt: null,
    triggeredMsg: '',
    code: '600519',
    name: '贵州茅台',
    type: 'price',
    op: 'lte',
    value: 1400,
    note: '买点',
    candCode: '600519',
    phase: 'armed',
  })
  assert.equal(data.plan[0].alertSyncedPrice, 1400)
})

test('云端持仓建议会生成补仓和减仓行动预警', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000001', {
    name: '平安银行',
    action: '加仓',
    addPrice: 10.12,
    reducePrice: 11.36,
    opQty: '减1手',
    exitTiming: '站稳均价线再操作',
    stopPrice: 9.8,
    targetPrice: 12,
    riskReward: '2:1',
    fundNote: '主力资金流入',
    invalidation: '跌破9.8元失效',
  }, { now, idFactory: ids })

  assert.equal(data.alerts.length, 2)
  assert.deepEqual(data.alerts.map((a) => [a.actKind, a.op, a.value]), [
    ['add', 'lte', 10.12],
    ['reduce', 'gte', 11.36],
  ])
  assert.equal(data.alerts[0].timing, '站稳均价线再操作')
  assert.equal(data.alerts[0].judgeContext.action, '加仓')
  assert.equal(data.alerts[0].judgeContext.stopPrice, 9.8)
  assert.equal(data.alerts[0].judgeContext.riskReward, '2:1')
  assert.equal(data.alerts[0].judgeContext.fundNote, '主力资金流入')
})

test('今日新建仓的减仓预警标记为 T+1 锁定且不能提示卖出', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000636', name: '风华高科' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000636', {
    addPrice: 13,
    reducePrice: 14,
    opQty: '减仓1手',
  }, {
    now,
    idFactory: ids,
    t1Status: { liveQty: 1, boughtToday: 1, sellableToday: 0 },
  })

  const reduce = data.alerts.find((alert) => alert.actKind === 'reduce')
  assert.equal(reduce.t1Blocked, true)
  assert.equal(reduce.sellableTodayQty, 0)
  assert.equal(reduce.opQty, '今日不可卖')
})

test('旧仓2手今日补1手时减仓预警最多提示2手', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000636', name: '风华高科' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000636', {
    reducePrice: 14,
    opQty: '减仓3手',
  }, {
    now,
    idFactory: ids,
    t1Status: { liveQty: 3, boughtToday: 1, sellableToday: 2 },
  })

  const reduce = data.alerts.find((alert) => alert.actKind === 'reduce')
  assert.equal(reduce.t1Blocked, false)
  assert.equal(reduce.opQty, '减仓2手')
})

test('相同价位保留旧预警状态并刷新Judge建议快照', () => {
  const old = {
    id: 'old',
    code: '000001',
    actCode: '000001',
    actKind: 'add',
    type: 'price',
    op: 'lte',
    value: 10.12,
    phase: 'watching',
    enabled: true,
  }
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行' }],
    alerts: [old],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '000001', {
    addPrice: 10.12,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.equal(data.alerts[0].id, 'old')
  assert.equal(data.alerts[0].phase, 'watching')
  assert.equal(data.alerts[0].judgeContext.addPrice, 10.12)
})

test('同一主计划调价时保留观察状态并改用动态价格带', () => {
  const old = {
    id: 'stable-plan-alert',
    code: '000001',
    actCode: '000001',
    actKind: 'add',
    type: 'price',
    op: 'lte',
    value: 10.06,
    phase: 'watching',
    watchingAt: now - 60000,
    enabled: true,
    judgeContext: {
      planId: 'plan-000001',
      planRevision: 2,
    },
  }
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行' }],
    alerts: [old],
    settings: {},
  }

  projectAdviceAlerts(data, '000001', {
    action: '加仓',
    addPrice: 10.2,
    continuity: {
      planId: 'plan-000001',
      revision: 3,
      thesisVersion: 1,
      changeType: 'adjust',
      zones: {
        add: { low: 10.14, high: 10.26, anchor: 10.2 },
      },
    },
  }, { now, idFactory: ids })

  assert.equal(data.alerts[0].id, 'stable-plan-alert')
  assert.equal(data.alerts[0].phase, 'watching')
  assert.equal(data.alerts[0].watchingAt, now - 60000)
  assert.equal(data.alerts[0].value, 10.26)
  assert.deepEqual(data.alerts[0].triggerZone, {
    low: 10.14,
    high: 10.26,
    anchor: 10.2,
  })
  assert.equal(data.alerts[0].judgeContext.planRevision, 3)
})

test('关闭 AI 自动预警时清理该股票的自动预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [
      { id: 'auto', code: '600519', candCode: '600519' },
      { id: 'manual', code: '600519', type: 'pct' },
    ],
    settings: { aiAutoAlert: false },
  }

  const changed = projectAdviceAlerts(data, '600519', {
    buyPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.deepEqual(data.alerts, [{ id: 'manual', code: '600519', type: 'pct' }])
})

test('股票已移出自选和持仓时不会从旧建议重建预警', () => {
  const data = {
    plan: [],
    holding: [],
    alerts: [
      { id: 'old', code: '600519', actCode: '600519', actKind: 'add' },
      { id: 'manual', code: '600519', type: 'pct' },
    ],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '600519', {
    addPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.deepEqual(data.alerts, [{ id: 'manual', code: '600519', type: 'pct' }])
})

test('军师主结论已是减仓时不再创建备用加仓预警', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '600000', name: '浦发银行' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '600000', {
    action: '减仓',
    actionPlan: '反弹到11元减仓1手',
    addPrice: 9.8,
    reducePrice: 11,
  }, { now, idFactory: ids })

  assert.deepEqual(data.alerts.map((alert) => alert.actKind), ['reduce'])
})
