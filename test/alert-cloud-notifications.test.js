import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { alertStore } from '../src/alertStore.js'
import { planStore } from '../src/planStore.js'
import {
  activateAccountSession,
} from '../shared/accountSessionScope.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('每次提醒使用同一份标题正文进入通知记录与全局横幅', () => {
  alertStore.clearAll()
  const notification = {
    alertId: 'banner-000636',
    code: '000636',
    name: '风华高科',
    title: '风华高科(000636)｜观察条件已到',
    body: '现55.34｜回踩加仓≤55.37\n正在复核',
  }

  assert.equal(alertStore.publish(notification), true)
  assert.equal(alertStore.get().notifications.length, 1)
  assert.equal(alertStore.get().banners.length, 1)
  assert.equal(
    alertStore.get().banners[0].title,
    alertStore.get().notifications[0].title,
  )
  assert.equal(
    alertStore.get().banners[0].body,
    alertStore.get().notifications[0].body,
  )

  assert.equal(alertStore.publish(notification), false)
  assert.equal(alertStore.get().notifications.length, 1)
  assert.equal(alertStore.get().banners.length, 1)

  alertStore.dismissBanner(alertStore.get().banners[0].id)
  assert.equal(alertStore.get().banners.length, 0)
})

test('应用根节点挂载全局预警横幅并原样展示通知内容', () => {
  const app = read('src/App.jsx')
  const store = read('src/alertStore.js')
  const serviceWorker = read('public/sw.js')
  assert.match(app, /function AlertBanner/)
  assert.match(app, /banner\.title/)
  assert.match(app, /banner\.body/)
  assert.match(app, /<AlertBanner\s*\/>/)
  assert.match(app, /event\?\.data\?\.type !== 'stock-alert'/)
  assert.match(serviceWorker, /client\.postMessage\(\{/)
  assert.match(serviceWorker, /type:\s*'stock-alert'/)
  assert.match(store, /if \(storedAlert\.reviewOnly\)/)
  assert.match(store, /this\._triggerReviewOnly\(storedAlert,\s*q\)/)
  assert.doesNotMatch(
    store,
    /if \(storedAlert\.reviewOnly\) continue/,
  )
})

test('前台命中也通过 Service Worker 展示系统通知', () => {
  const store = read('src/alertStore.js')
  const systemNotification = read('src/systemNotification.js')

  assert.match(store, /showSystemNotification\(notification\)/)
  assert.doesNotMatch(store, /new Notification\(/)
  assert.match(
    systemNotification,
    /registration\.showNotification\(title,\s*options\)/,
  )
  assert.match(systemNotification, /alertId/)
})

test('页面轮询发现观察价到达后立即提交复核并显示同内容横幅', async () => {
  const now = Date.parse('2026-08-28T05:30:00.000Z')
  const triggeredAt = Date.now()
  const originalFetch = global.fetch
  let requestBody = null
  activateAccountSession('测试账号')
  alertStore.clearAll()
  planStore.setData({
    plan: [{ code: '000636', name: '风华高科' }],
    holding: [],
    closed: [],
    settings: {},
    advice: {
      '000636': {
        mode: 'buy_advice',
        advice: {
          continuity: {
            planId: 'plan-000636',
            revision: 3,
          },
        },
      },
    },
    alerts: [{
      id: 'review-000636',
      code: '000636',
      name: '风华高科',
      type: 'price',
      op: 'lte',
      value: 55.37,
      note: '回踩加仓复核',
      reviewOnly: true,
      enabled: true,
      phase: 'armed',
      judgeContext: {
        planId: 'plan-000636',
        planRevision: 3,
      },
    }],
  })
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return {
      json: async () => ({
        ok: true,
        accepted: true,
        alert: {
          id: 'review-000636',
          code: '000636',
          phase: 'reviewing',
          enabled: false,
          triggeredAt,
          triggeredMsg: '观察价已到：现价 55.34 ≤ 55.37',
          decisionPrice: 55.34,
          decisionDeadlineAt: triggeredAt + 120000,
        },
      }),
    }
  }

  try {
    alertStore.evaluate({
      '000636': {
        code: '000636',
        price: 55.34,
        tradeDate: '2026-08-28',
        isLivePrice: true,
      },
    }, now)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(requestBody.op, 'triggerPriceReview')
    assert.equal(requestBody.alertId, 'review-000636')
    assert.equal(planStore.get().alerts[0].phase, 'reviewing')
    assert.equal(planStore.get().alerts[0].enabled, false)
    assert.equal(alertStore.get().banners[0].title, '风华高科｜回踩加仓已到')
    assert.match(alertStore.get().banners[0].body, /55\.34.*55\.37/)
  } finally {
    global.fetch = originalFetch
    activateAccountSession('')
    alertStore.clearAll()
  }
})

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
  assert.match(notification.title, /本次不买入/)
  assert.doesNotMatch(notification.body, /维持观望|不操作/)
  assert.doesNotMatch(notification.body, /本次触发结束|不新增复核价/)
})
