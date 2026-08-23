import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'
import { accountTradeStateFingerprint } from '../shared/accountSync.js'
import { beijingDayStartTs } from '../shared/portfolioAccounting.js'

test('两台设备加载同一跨日做T快照后生成相同的自动结算账本', () => {
  const dayStart = beijingDayStartTs(Date.now())
  const snapshot = {
    plan: [],
    holding: [{
      id: 'holding-sync',
      code: '600000',
      name: '同步测试股',
      qty: 2,
      buyPrice: 10,
      buyFee: 5,
      buyAt: dayStart - 2 * 86400000,
      tRealizedPnl: 0,
      tFlows: [{
        id: 'flow-sync-buy',
        side: 'buy',
        price: 9.8,
        qty: 1,
        fee: 5,
        cashFlow: -985,
        cashApplied: true,
        at: dayStart - 86400000,
      }],
    }],
    closed: [],
    alerts: [],
    adviceLog: [],
    decisionLog: [],
    account: {
      totalAssets: 100000,
      cash: 50000,
      riskDayStartAt: dayStart,
      dayStartAssets: 100000,
    },
  }

  planStore.setData(structuredClone(snapshot))
  const first = structuredClone(planStore.get())
  planStore.setData(structuredClone(snapshot))
  const second = structuredClone(planStore.get())

  assert.equal(accountTradeStateFingerprint(first), accountTradeStateFingerprint(second))
  assert.deepEqual(
    first.closed.map((record) => ({ id: record.id, batchId: record.batchId })),
    second.closed.map((record) => ({ id: record.id, batchId: record.batchId })),
  )
})
