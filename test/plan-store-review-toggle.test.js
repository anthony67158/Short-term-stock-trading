import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'
import { isAdviceReviewEnabled } from '../shared/adviceReviewPolicy.js'

test('个股持续复核开关关闭时立即清理派生预警并保留手工预警', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    settings: {},
    alerts: [
      { id: 'auto', code: '600000', candCode: '600000' },
      { id: 'manual', code: '600000', type: 'pct' },
    ],
  })

  planStore.setAdviceReviewEnabled('600000', false)

  assert.equal(isAdviceReviewEnabled(planStore.get().settings, '600000'), false)
  assert.deepEqual(planStore.get().alerts.map((alert) => alert.id), ['manual'])
})

test('另一设备更新的单股复核开关通过增量同步立即生效', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    settings: {
      'advReview.disabledCodes': [],
      'advAuto.configUpdatedAt': 1000,
    },
    alerts: [
      { id: 'auto', code: '600000', candCode: '600000' },
      { id: 'manual', code: '600000', type: 'pct' },
    ],
  })

  planStore.mergeCloud({
    settings: {
      'advReview.disabledCodes': ['600000'],
      'advAuto.configUpdatedAt': 2000,
    },
  })

  assert.equal(isAdviceReviewEnabled(planStore.get().settings, '600000'), false)
  assert.deepEqual(planStore.get().alerts.map((alert) => alert.id), ['manual'])
})

test('个股重新开启持续复核时加入对应的显式白名单', () => {
  const previousUpdatedAt = Date.now() + 1000
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [{ code: '600000', name: '浦发银行' }],
    closed: [],
    settings: {
      'advAuto.holdCodes': [],
      'advAuto.watchCodes': [],
      'advReview.disabledCodes': ['600000', '000001'],
      'advAuto.configUpdatedAt': previousUpdatedAt,
    },
    alerts: [],
  })

  planStore.setAdviceReviewEnabled('600000', true)
  planStore.setAdviceReviewEnabled('000001', true)

  assert.deepEqual(
    planStore.get().settings['advAuto.holdCodes'],
    ['600000'],
  )
  assert.deepEqual(
    planStore.get().settings['advAuto.watchCodes'],
    ['000001'],
  )
  assert.equal(isAdviceReviewEnabled(
    planStore.get().settings,
    '600000',
  ), true)
  assert.equal(isAdviceReviewEnabled(
    planStore.get().settings,
    '000001',
  ), true)
  assert.ok(
    planStore.get().settings['advAuto.configUpdatedAt']
      > previousUpdatedAt,
  )

  planStore.setAdviceReviewEnabled('600000', false)
  assert.deepEqual(
    planStore.get().settings['advAuto.holdCodes'],
    [],
  )
})

test('开启单股持续复核会同步开启自动预警总开关', () => {
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [],
    closed: [],
    settings: {
      aiAutoAlert: false,
      'advReview.disabledCodes': ['000001'],
    },
    alerts: [],
  })

  planStore.setAdviceReviewEnabled('000001', true)

  assert.equal(planStore.get().settings.aiAutoAlert, true)
  assert.equal(
    isAdviceReviewEnabled(planStore.get().settings, '000001'),
    true,
  )
})

test('云端生成的新行动预警增量同步到当前页面', () => {
  planStore.setData({
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
    alerts: [],
  })

  const changed = planStore.mergeCloud({
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
      phase: 'armed',
      createdAt: Date.now(),
      triggeredAt: null,
    }],
  })

  assert.equal(changed, true)
  assert.equal(planStore.get().alerts.length, 1)
  assert.equal(planStore.get().alerts[0].id, 'cloud-reduce')
})
