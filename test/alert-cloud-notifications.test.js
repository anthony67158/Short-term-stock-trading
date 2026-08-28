import test from 'node:test'
import assert from 'node:assert/strict'

import { alertStore } from '../src/alertStore.js'
import { planStore } from '../src/planStore.js'

test('云端近期到价事件回灌为去重的站内预警通知', () => {
  alertStore.clearAll()
  const watchingAt = Date.now() - 1000
  const data = {
    plan: [],
    holding: [{
      id: 'holding-1',
      code: '002309',
      name: '中利集团',
      qty: 25,
      buyPrice: 3.1,
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    settings: {},
    alerts: [{
      id: 'cloud-reduce',
      code: '002309',
      name: '中利集团',
      type: 'price',
      op: 'gte',
      value: 3.052,
      actCode: '002309',
      actKind: 'reduce',
      enabled: true,
      phase: 'watching',
      watchingAt,
      watchingPrice: 3.06,
      watchingMsg: '现价 3.06 ≥ 3.052',
    }],
  }

  planStore.setData(data)
  planStore.setData(data)

  assert.equal(alertStore.get().notifications.length, 1)
  assert.equal(alertStore.get().unread, 1)
  assert.equal(alertStore.get().notifications[0].alertId, 'watch-cloud-reduce')
})

test('云端Judge维持结论回灌为终态通知而不是再次等待', () => {
  alertStore.clearAll()
  const triggeredAt = Date.now() - 1000
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    settings: {},
    alerts: [{
      id: 'cloud-buy-wait',
      code: '600000',
      name: '浦发银行',
      type: 'price',
      op: 'gte',
      value: 10,
      note: '买入点',
      enabled: false,
      phase: 'reviewed',
      triggeredAt,
      triggeredMsg: '维持观望；本次触发结束，不新增复核价',
      decisionPrice: 10.02,
    }],
  })

  const notification = alertStore.get().notifications[0]
  assert.equal(notification.alertId, 'review-wait-cloud-buy-wait')
  assert.match(notification.title, /维持观望/)
  assert.match(notification.body, /本次触发结束/)
})
