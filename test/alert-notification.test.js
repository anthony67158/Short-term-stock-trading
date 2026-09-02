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

test('到价待确认通知先展示股票和动作且正文只保留执行要点', () => {
  const notification = buildAlertNotification({
    alert: reduceAlert,
    quote: { price: 3.06 },
    stage: 'watch',
  })

  assert.equal(notification.title, '中利集团(002309)｜减仓观察价已到')
  assert.equal(
    notification.body,
    '现3.06｜目标≥3.05｜减仓9手\n当前不减仓；先观察约60秒，确认冲高转弱后复核',
  )
  assert.doesNotMatch(notification.body, /系统正在|确认后会|详情见|到价≠/)
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

  assert.equal(watching.title, '中利集团(002309)｜清仓观察价已到')
  assert.match(watching.body, /当前不清仓；先观察约60秒/)
  assert.equal(confirmed.title, '中利集团(002309)｜现在清仓')
  assert.match(confirmed.body, /执行：清仓1手/)
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

test('失效通知保留股票代码并明确放弃本次动作', () => {
  const notification = buildAlertNotification({
    alert: { ...reduceAlert, name: '' },
    quote: { price: 3.01 },
    stage: 'invalid',
  })

  assert.equal(notification.title, '002309｜放弃本次减仓')
  assert.match(notification.body, /结论：放弃本次减仓；本次触发结束/)
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
    '中利集团(002309)｜本次不加仓、不减仓',
  )
  assert.match(
    notification.body,
    /结论：本次不加仓、不减仓；本次触发结束/,
  )
  assert.match(notification.body, /冲高后未转弱/)
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

  assert.equal(notification.title, '贵州茅台(600519)｜本次不买入')
  assert.doesNotMatch(notification.body, /维持观望|不操作/)
  assert.match(notification.body, /本次触发结束/)
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

  assert.equal(notification.title, '贵州茅台(600519)｜观察条件已到')
  assert.match(notification.body, /观察价≥145\.24/)
  assert.match(
    notification.body,
    /先持续观察约60秒，再核对分时、量能和资金；2分钟内给出明确结论/,
  )
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
