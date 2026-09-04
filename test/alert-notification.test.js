import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAlertNotification,
  userFacingAlertMessage,
} from '../shared/alertNotification.js'

const reduceAlert = {
  id: 'reduce-1',
  code: '002309',
  name: '中利集团',
  type: 'price',
  op: 'gte',
  value: 3.05,
  actKind: 'reduce',
  opQty: '减仓9手',
}

test('到价观察通知明确禁止立即执行并只保留价位与复核时限', () => {
  const notification = buildAlertNotification({
    alert: reduceAlert,
    quote: { price: 3.06 },
    stage: 'watch',
  })

  assert.equal(notification.title, '中利集团｜减仓观察已到')
  assert.equal(
    notification.body,
    '002309｜现价3.06≥3.05｜先不减仓，复核中，约60秒后给结论',
  )
  assert.equal(notification.tag, 'trade-alert-reduce-1')
  assert.equal(notification.renotify, false)
  assert.equal(notification.urgency, 'normal')
  assert.equal(notification.ttl, 180)
  assert.doesNotMatch(
    notification.body,
    /系统正在|确认后会|详情见|到价≠|立即减仓/,
  )
})

test('一手清仓观察只在确认后提示执行', () => {
  const alert = {
    ...reduceAlert,
    note: '清仓观察位',
    opQty: '清仓1手',
  }
  const watching = buildAlertNotification({
    alert,
    quote: { price: 40.22 },
    stage: 'watch',
  })
  const confirmed = buildAlertNotification({
    alert,
    quote: { price: 40.18 },
    stage: 'confirm',
    reason: '冲高不能站稳且主力继续流出',
  })

  assert.equal(watching.title, '中利集团｜清仓观察已到')
  assert.match(watching.body, /先不清仓，复核中，约60秒后给结论/)
  assert.equal(confirmed.title, '中利集团｜立即清仓1手')
  assert.match(confirmed.body, /002309｜现价40\.18/)
  assert.doesNotMatch(confirmed.body, /执行[:：]/)
})

test('买入加仓和止损到价都只提示观察，不提前显示执行手数', () => {
  const scenarios = [
    {
      alert: {
        ...reduceAlert,
        id: 'buy-1',
        actKind: '',
        note: '买入点',
        opQty: '买入2手',
      },
      title: '中利集团｜买入观察已到',
      instruction: '先不买入，复核中，约60秒后给结论',
    },
    {
      alert: {
        ...reduceAlert,
        id: 'add-1',
        actKind: 'add',
        note: '回踩加仓',
        opQty: '加仓2手',
      },
      title: '中利集团｜加仓观察已到',
      instruction: '先不加仓，复核中，约60秒后给结论',
    },
    {
      alert: {
        ...reduceAlert,
        id: 'stop-1',
        actKind: '',
        note: '止损位',
        opQty: '卖出2手',
      },
      title: '中利集团｜止损观察已到',
      instruction: '先不卖出，复核中，约20秒后给结论',
    },
  ]

  for (const scenario of scenarios) {
    const notification = buildAlertNotification({
      alert: scenario.alert,
      quote: { price: 3.06 },
      stage: 'watch',
    })
    assert.equal(notification.title, scenario.title)
    assert.match(notification.body, new RegExp(scenario.instruction))
    assert.doesNotMatch(
      `${notification.title} ${notification.body}`,
      /立即|执行[:：]|\d+手/,
    )
  }
})

test('确认通知一眼显示现在做什么并限制冗长理由', () => {
  const notification = buildAlertNotification({
    alert: reduceAlert,
    quote: { price: 3.07 },
    stage: 'confirm',
    reason: '分时冲高后回落并跌破均价线，量能同步放大，短线卖点已经确认，建议立即执行不要再等待',
  })

  assert.equal(notification.title, '中利集团｜立即减仓9手')
  assert.match(notification.body, /^002309｜现价3\.07｜分时冲高后回落并跌破均价线/)
  assert.equal(notification.tag, 'trade-alert-reduce-1')
  assert.equal(notification.renotify, true)
  assert.equal(notification.urgency, 'high')
  assert.equal(notification.ttl, 300)
  assert.ok(notification.body.length <= 72)
})

test('失效通知保留股票代码并明确放弃本次动作', () => {
  const notification = buildAlertNotification({
    alert: { ...reduceAlert, name: '' },
    quote: { price: 3.01 },
    stage: 'invalid',
  })

  assert.equal(notification.title, '002309｜取消减仓')
  assert.equal(notification.body, '现价3.01｜条件已失效')
  assert.equal(notification.renotify, false)
  assert.equal(notification.silent, true)
})

test('未确认通知给出本轮不调仓终态而不是继续循环观察', () => {
  const notification = buildAlertNotification({
    alert: reduceAlert,
    quote: { price: 3.04 },
    stage: 'wait',
    reason: '冲高后未转弱',
  })

  assert.equal(
    notification.title,
    '中利集团｜继续持有',
  )
  assert.match(notification.body, /002309｜现价3\.04/)
  assert.match(notification.body, /本次不加仓、不减仓/)
  assert.match(notification.body, /冲高后未转弱/)
  assert.doesNotMatch(notification.body, /本次触发结束/)
  assert.equal(notification.renotify, false)
  assert.equal(notification.silent, true)
})

test('历史终局用语在通知层改写为本轮明确动作', () => {
  const notification = buildAlertNotification({
    alert: {
      code: '600519',
      name: '贵州茅台',
      type: 'price',
      op: 'lte',
      value: 145,
      note: '买入点',
    },
    quote: { price: 144.9 },
    stage: 'wait',
    reason: '维持观望；本次触发结束，不新增复核价',
  })

  assert.equal(notification.title, '贵州茅台｜本次不买入')
  assert.doesNotMatch(notification.body, /维持观望|不操作/)
  assert.doesNotMatch(notification.body, /本次触发结束|不新增复核价/)
  assert.equal(
    userFacingAlertMessage({
      ...reduceAlert,
      triggeredMsg: '维持持有；本次触发结束',
    }),
    '本次不加仓、不减仓，继续持有现有仓位；本次触发结束',
  )
})

test('观察价命中时明确通知正在复核且不暗示下单', () => {
  const notification = buildAlertNotification({
    alert: {
      code: '600519',
      name: '贵州茅台',
      type: 'price',
      op: 'gte',
      value: 145.24,
      note: '观察价复核',
      reviewOnly: true,
    },
    quote: { price: 145.3 },
    stage: 'review',
    reason: '观察价已到',
  })

  assert.equal(notification.title, '贵州茅台｜观察价已到')
  assert.equal(
    notification.body,
    '600519｜现价145.3≥145.24｜复核中，约2分钟内给结论',
  )
  assert.equal(notification.tag, 'trade-alert-600519')
  assert.equal(notification.ttl, 180)
})

test('非价格预警保留实际命中数值', () => {
  const notification = buildAlertNotification({
    alert: {
      code: '600519',
      name: '贵州茅台',
      type: 'pct',
      op: 'gte',
      value: 5,
    },
    stage: 'trigger',
    reason: '涨跌幅 6.20% ≥ 5%',
  })

  assert.equal(notification.title, '贵州茅台｜涨跌幅达标')
  assert.equal(notification.body, '600519｜涨跌幅6.20%≥5%')
  assert.doesNotMatch(notification.body, /执行[:：]/)
})
