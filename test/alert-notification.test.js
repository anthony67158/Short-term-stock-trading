import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAlertNotification } from '../shared/alertNotification.js'

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

test('到价待确认通知先展示股票和动作且正文只保留执行要点', () => {
  const notification = buildAlertNotification({
    alert: reduceAlert,
    quote: { price: 3.06 },
    stage: 'watch',
  })

  assert.equal(notification.title, '中利集团(002309)｜减仓待确认')
  assert.equal(notification.body, '现3.06｜目标≥3.05｜减仓9手\n先不卖，等冲高转弱')
  assert.doesNotMatch(notification.body, /系统正在|确认后会|详情见|到价≠/)
})

test('确认通知一眼显示现在做什么并限制冗长理由', () => {
  const notification = buildAlertNotification({
    alert: reduceAlert,
    quote: { price: 3.07 },
    stage: 'confirm',
    reason: '分时冲高后回落并跌破均价线，量能同步放大，短线卖点已经确认，建议立即执行不要再等待',
  })

  assert.equal(notification.title, '中利集团(002309)｜现在减仓')
  assert.match(notification.body, /^现3\.07｜目标≥3\.05｜减仓9手\n执行：减仓9手/)
  assert.ok(notification.body.length <= 92)
})

test('失效通知保留股票代码并明确暂停动作', () => {
  const notification = buildAlertNotification({
    alert: { ...reduceAlert, name: '' },
    quote: { price: 3.01 },
    stage: 'invalid',
  })

  assert.equal(notification.title, '002309｜暂停减仓')
  assert.match(notification.body, /动作：暂停，等军师重算/)
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

  assert.equal(notification.title, '贵州茅台(600519)｜涨跌幅提醒')
  assert.equal(notification.body, '涨跌幅 6.20% ≥ 5%\n执行：涨跌幅')
})
