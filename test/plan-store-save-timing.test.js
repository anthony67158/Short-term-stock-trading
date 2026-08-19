import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'

test('确认建仓后在当前事件循环立即提交账号账本', async () => {
  let saved = null
  planStore.registerSaver(async (data) => {
    saved = structuredClone(data)
    return true
  })
  planStore.setData({
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    closed: [],
    alerts: [],
    decisionLog: [],
    account: { cash: 200000 },
  })

  const result = planStore.buy('600519', 1500, 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(result.ok, true)
  assert.equal(saved?.holding?.[0]?.code, '600519')
  assert.equal(saved?.closed?.[0]?.type, 'BUY')
})

test('减仓成交在当前事件循环立即提交最新持仓与成交记录', async () => {
  let saved = null
  planStore.registerSaver(async (data) => {
    saved = structuredClone(data)
    return true
  })
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-1',
      code: '002309',
      name: '中利集团',
      qty: 25,
      buyPrice: 3.26,
      buyFee: 5.08,
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    alerts: [],
    decisionLog: [],
    account: { cash: 58000 },
  })

  const result = planStore.sell('holding-1', 3.05, 9)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(result.ok, true)
  assert.equal(saved?.holding?.[0]?.qty, 16)
  assert.equal(saved?.closed?.[0]?.type, 'SELL')
  assert.equal(saved?.closed?.[0]?.qty, 9)
  assert.equal(saved?.closed?.[0]?.price, 3.05)
})

test('加仓和做T录入也在当前事件循环立即提交最新账本', async () => {
  const saved = []
  planStore.registerSaver(async (data) => {
    saved.push(structuredClone(data))
    return true
  })
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-2',
      code: '002309',
      name: '中利集团',
      qty: 10,
      buyPrice: 3.2,
      buyFee: 5,
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    alerts: [],
    decisionLog: [],
    account: { cash: 58000 },
  })

  const added = planStore.addToHolding('holding-2', 3.1, 2)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(added.ok, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].holding[0].qty, 12)
  assert.equal(saved[0].closed[0].type, 'BUY')

  planStore.setData({
    ...saved[0],
    holding: [{
      ...saved[0].holding[0],
      buyAt: Date.now() - 86400000,
    }],
  })
  const tFlow = planStore.addTFlow('holding-2', 'sell', 3.3, 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(tFlow.ok, true)
  assert.equal(saved.length, 2)
  assert.equal(saved[1].holding[0].tFlows[0].side, 'sell')
  assert.equal(saved[1].holding[0].tFlows[0].qty, 1)
})
