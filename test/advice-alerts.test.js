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
    addPrice: 10.12,
    reducePrice: 11.36,
    opQty: '减1手',
    exitTiming: '站稳均价线再操作',
  }, { now, idFactory: ids })

  assert.equal(data.alerts.length, 2)
  assert.deepEqual(data.alerts.map((a) => [a.actKind, a.op, a.value]), [
    ['add', 'lte', 10.12],
    ['reduce', 'gte', 11.36],
  ])
  assert.equal(data.alerts[0].timing, '站稳均价线再操作')
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

test('相同价位保留旧预警状态，不重复武装', () => {
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

  assert.equal(changed, false)
  assert.equal(data.alerts[0], old)
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
