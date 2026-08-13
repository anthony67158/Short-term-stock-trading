import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore, t1StatusOf } from '../src/planStore.js'

test('刚建仓后可立即把最新持仓和现金刷新到云端生成上下文', async () => {
  let saved = null
  planStore.registerSaver(async (data) => {
    saved = data
    return true
  })
  planStore.setData({
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    closed: [],
    account: { cash: 200000 },
  })

  planStore.buy('600519', 1400, 1)
  const flushed = await planStore.flushSave()

  assert.equal(flushed, true)
  assert.equal(saved.holding[0].code, '600519')
  assert.equal(saved.holding[0].qty, 1)
  assert.equal(saved.account.cash < 200000, true)
  planStore.registerSaver(null)
})

test('真实账本入口阻止卖出今日买入仓位', () => {
  planStore.setData({
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    closed: [],
  })
  planStore.buy('600519', 1400, 1)

  const holding = planStore.get().holding[0]
  const result = planStore.sell(holding.id, 1410, 1)

  assert.equal(result.ok, false)
  assert.match(result.error, /T\+1/)
  assert.equal(planStore.get().holding[0].qty, 1)
  assert.equal(planStore.get().closed.filter((x) => x.type === 'SELL').length, 0)
})

test('历史持仓仍可正常卖出', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'old_holding',
      code: '000001',
      name: '平安银行',
      buyPrice: 10,
      buyAt: Date.now() - 86400000,
      qty: 2,
      buyFee: 5,
    }],
    closed: [],
  })

  const result = planStore.sell('old_holding', 10.5, 1)

  assert.equal(result.ok, true)
  assert.equal(result.qty, 1)
  assert.equal(planStore.get().holding[0].qty, 1)
})

test('减仓后仍留在持仓区，只有同股全部清仓才回自选', () => {
  const yesterday = Date.now() - 86400000
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [
      { id: 'lot_1', code: '600000', name: '浦发银行', buyPrice: 10, buyAt: yesterday, qty: 2, buyFee: 5 },
      { id: 'lot_2', code: '600000', name: '浦发银行', buyPrice: 10.2, buyAt: yesterday, qty: 1, buyFee: 5 },
    ],
    closed: [],
  })

  assert.equal(planStore.get().plan.some((item) => item.code === '600000'), false)

  planStore.sell('lot_1', 10.5, 1)
  assert.equal(planStore.get().holding.some((item) => item.code === '600000'), true)
  assert.equal(planStore.get().plan.some((item) => item.code === '600000'), false)

  planStore.sell('lot_1', 10.5, 1)
  assert.equal(planStore.get().plan.some((item) => item.code === '600000'), false)

  planStore.sell('lot_2', 10.5, 1)
  assert.equal(planStore.get().holding.some((item) => item.code === '600000'), false)
  assert.equal(planStore.get().plan.filter((item) => item.code === '600000').length, 1)
})

test('最后一笔持仓清仓后自动退役该股加减仓和止盈止损预警', () => {
  const yesterday = Date.now() - 86400000
  planStore.setData({
    plan: [],
    holding: [{
      id: 'position_1',
      code: '600000',
      name: '浦发银行',
      buyPrice: 10,
      buyAt: yesterday,
      qty: 1,
      buyFee: 5,
    }],
    closed: [],
    alerts: [
      { id: 'add', code: '600000', actCode: '600000', actKind: 'add', enabled: true, phase: 'watching' },
      { id: 'reduce', code: '600000', actCode: '600000', actKind: 'reduce', enabled: true, phase: 'armed' },
      { id: 'stop', code: '600000', planId: 'position_1', note: '止损', enabled: true, phase: 'armed' },
      { id: 'manual', code: '600000', type: 'pct', enabled: true },
    ],
  })

  const result = planStore.sell('position_1', 10.5, 1)
  const alerts = planStore.get().alerts

  assert.equal(result.ok, true)
  assert.equal(alerts.find((alert) => alert.id === 'manual').enabled, true)
  for (const id of ['add', 'reduce', 'stop']) {
    const alert = alerts.find((item) => item.id === id)
    assert.equal(alert.enabled, false)
    assert.equal(alert.phase, 'invalid')
    assert.equal(alert.retiredPolicy === 'position-missing' || alert.retiredPolicy === 'holding-plan-missing', true)
  }
})

test('前端自选股建议不能同步成加仓或减仓行动预警', () => {
  planStore.setData({
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    closed: [],
    alerts: [],
    advice: {
      '600519': {
        at: Date.now(),
        advice: {
          action: '立即买入',
          addPrice: 1400,
          reducePrice: 1500,
        },
      },
    },
  })

  planStore.syncActionAlerts('600519')

  assert.equal(planStore.get().alerts.some((alert) => alert.actCode === '600519'), false)
})

test('做T卖腿同样受今日可卖数量约束', () => {
  const now = Date.now()
  planStore.setData({
    plan: [],
    holding: [{
      id: 'today_holding',
      code: '000002',
      name: '万科A',
      buyPrice: 8,
      buyAt: now,
      qty: 1,
      buyFee: 5,
    }],
    closed: [{
      id: 'buy_today',
      type: 'BUY',
      code: '000002',
      name: '万科A',
      qty: 1,
      price: 8,
      at: now,
    }],
  })

  const result = planStore.addTFlow('today_holding', 'sell', 8.2, 1)

  assert.equal(result.ok, false)
  assert.match(result.error, /T\+1/)
  assert.equal((planStore.get().holding[0].tFlows || []).length, 0)
})

test('今日新建仓的止盈止损预警保留观察价但标记 T+1 锁定', () => {
  const now = Date.now()
  planStore.setData({
    plan: [],
    holding: [{
      id: 'new_position',
      code: '000636',
      name: '风华高科',
      buyPrice: 13,
      buyAt: now,
      qty: 1,
      buyFee: 5,
    }],
    closed: [{
      id: 'buy_today',
      type: 'BUY',
      code: '000636',
      qty: 1,
      price: 13,
      at: now,
    }],
    alerts: [],
  })

  planStore.setPlanRule('new_position', { tp: 14, sl: 12 })

  const alerts = planStore.get().alerts.filter((alert) => alert.planId === 'new_position')
  assert.equal(alerts.length, 2)
  assert.equal(alerts.every((alert) => alert.t1Blocked === true), true)
  assert.equal(alerts.every((alert) => alert.sellableTodayQty === 0), true)
})

test('旧仓2手今日补1手时预警记录今日最多可卖2手', () => {
  const now = Date.now()
  planStore.setData({
    plan: [],
    holding: [{
      id: 'mixed_position',
      code: '000636',
      name: '风华高科',
      buyPrice: 13,
      buyAt: now - 86400000,
      qty: 3,
      buyFee: 5,
    }],
    closed: [{
      id: 'add_today',
      type: 'BUY',
      code: '000636',
      qty: 1,
      price: 13.2,
      at: now,
    }],
    alerts: [],
  })

  planStore.setPlanRule('mixed_position', { tp: 14, sl: 12 })

  const alerts = planStore.get().alerts.filter((alert) => alert.planId === 'mixed_position')
  assert.equal(alerts.every((alert) => alert.t1Blocked === false), true)
  assert.equal(alerts.every((alert) => alert.sellableTodayQty === 2), true)
})

test('修改加仓记录日期后T+1按新日期重新计算', () => {
  const now = Date.now()
  const yesterday = new Date(now - 86400000)
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
  planStore.setData({
    plan: [],
    holding: [{
      id: 'h1',
      code: '600000',
      name: '浦发银行',
      buyPrice: 10,
      buyAt: now - 86400000,
      qty: 3,
      buyFee: 5,
    }],
    closed: [{
      id: 'buy-today',
      type: 'BUY',
      code: '600000',
      name: '浦发银行',
      holdingId: 'h1',
      qty: 1,
      price: 10.2,
      at: now,
    }],
    decisionLog: [{
      id: 'execution:buy-today',
      kind: 'execution',
      transactionId: 'buy-today',
      at: now,
      executedAt: now,
    }],
  })

  assert.equal(t1StatusOf('600000').boughtToday, 1)
  assert.equal(planStore.updateClosedDate('buy-today', day).ok, true)
  assert.equal(t1StatusOf('600000').boughtToday, 0)
  assert.equal(new Date(planStore.get().closed[0].at).getDate(), yesterday.getDate())
  assert.equal(new Date(planStore.get().decisionLog[0].executedAt).getDate(), yesterday.getDate())
})

test('交易记录日期不能改到未来或非法日期', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [{ id: 'buy-1', type: 'BUY', code: '600000', at: Date.now() }],
  })
  assert.equal(planStore.updateClosedDate('buy-1', 'invalid').ok, false)
  assert.equal(planStore.updateClosedDate('buy-1', '2999-01-01').ok, false)
})

test('未归档做T买腿修改到历史日期后立即重算T+1并结算', () => {
  const now = Date.now()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const dateText = [
    yesterday.getFullYear(),
    String(yesterday.getMonth() + 1).padStart(2, '0'),
    String(yesterday.getDate()).padStart(2, '0'),
  ].join('-')
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-t',
      code: '600000',
      name: '浦发银行',
      buyPrice: 10,
      buyAt: now - 86400000,
      qty: 2,
      buyFee: 5,
      tFlows: [{
        id: 'flow-buy',
        side: 'buy',
        price: 9.8,
        qty: 1,
        fee: 5,
        at: now,
      }],
    }],
    closed: [],
  })

  assert.equal(t1StatusOf('600000').boughtToday, 1)
  const result = planStore.updateTFlowDate(
    'holding-t',
    'flow-buy',
    dateText,
  )

  assert.equal(result.ok, true)
  assert.equal(t1StatusOf('600000').boughtToday, 0)
  assert.equal(planStore.get().holding[0].tFlows.length, 0)
  assert.equal(planStore.get().holding[0].qty, 3)
  assert.equal(planStore.get().closed[0].type, 'BUY')
  assert.equal(new Date(planStore.get().closed[0].at).getDate(), yesterday.getDate())
})

test('未归档做T流水日期拒绝未来和非法值', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-t',
      code: '600000',
      buyPrice: 10,
      buyAt: Date.now() - 86400000,
      qty: 2,
      tFlows: [{
        id: 'flow-buy',
        side: 'buy',
        price: 9.8,
        qty: 1,
        fee: 5,
        at: Date.now(),
      }],
    }],
    closed: [],
  })

  assert.equal(planStore.updateTFlowDate('holding-t', 'flow-buy', 'invalid').ok, false)
  assert.equal(planStore.updateTFlowDate('holding-t', 'flow-buy', '2999-01-01').ok, false)
})
