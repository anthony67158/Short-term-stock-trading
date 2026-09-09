import test from 'node:test'
import assert from 'node:assert/strict'
import { compileMonitoringPlan, evaluateMonitoringRule, monitoringAlerts, monitoringView, trackedRuleHit } from '../shared/monitoringPlan.js'

const now = Date.parse('2026-09-09T02:00:00Z')
const quote = { code: '002475', price: 55.07, prevClose: 54.16, open: 54.2, mainInflow: -1e8, vwap: 55, tradeDate: '2026-09-09', isLivePrice: true }
const rules = [
  { action: 'EXIT', kind: 'RISK_EXIT', lots: 1, logic: 'ANY', conditions: [
    { metric: 'price', op: 'lte', value: 54 }, { metric: 'mainNetYi', op: 'lte', value: -3 },
  ] },
  { action: 'REDUCE', kind: 'PROFIT_EXIT', lots: 1, logic: 'ALL', conditions: [{ metric: 'price', op: 'gte', value: 56 }] },
  { action: 'HOLD', logic: 'ALL', conditions: [{ metric: 'priceVsVwapPct', op: 'gte', value: 0 }, { metric: 'mainNetYi', op: 'gte', value: 0 }] },
]
const advice = { action: '持有', executionRules: rules }
const plan = compileMonitoringPlan({
  advice, payload: { code: '002475', holdQty: 1, todayQuote: quote, tech: { atr: 1.5 } },
  decisionPlan: { mode: 'hold_advice', decisionId: 'decision-test', validUntil: new Date(now + 3600000).toISOString() }, now,
})
advice.monitoringPlan = plan

test('多条件计划以风险退出优先，1手减仓统一为清仓且只有明确规则', () => {
  assert.equal(plan.state, 'READY')
  assert.equal(plan.rules[0].kind, 'RISK_EXIT')
  assert.equal(plan.rules[1].action, 'EXIT')
  assert.equal(plan.rules[2].sustainSeconds, 60)
  const alerts = monitoringAlerts({ holding: [{ code: '002475' }] }, '002475', advice, now)
  assert.equal(alerts.length, 2)
  assert.ok(alerts.every((item) => item.actKind === 'reduce'))
})

test('只有持有描述而没有退出动作不能冒充已建立跟踪', () => {
  const invalid = compileMonitoringPlan({
    advice: { executionRules: [rules[2]] },
    payload: { code: '002475', holdQty: 1, todayQuote: quote, tech: { atr: 1.5 } },
    decisionPlan: { mode: 'hold_advice', decisionId: 'invalid', validUntil: new Date(now + 3600000).toISOString() },
    now,
  })
  assert.equal(invalid.state, 'INVALID')
  assert.match(invalid.errors.join('；'), /缺少可执行的减仓或清仓规则/)
})

test('资金条件独立命中OR退出，缺失资金不能当零或当作已确认', () => {
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, mainInflow: -3.1e8 }, { now }).matched, true)
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, price: 53.99 }, { now }).matched, true)
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, mainInflow: null }, { now }).state, 'MISSING_DATA')
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, isLivePrice: false }, { now }).matched, false)
})

test('站稳均价线必须连续60秒，数据断档或跌回即重新计时', () => {
  const strong = { ...quote, mainInflow: 1e8 }
  const first = evaluateMonitoringRule(plan.rules[2], strong, { now })
  assert.equal(first.state, 'OBSERVING')
  assert.equal(evaluateMonitoringRule(plan.rules[2], strong, { now: now + 60000, previous: first }).matched, true)
  assert.equal(evaluateMonitoringRule(plan.rules[2], strong, { now: now + 120000, previous: first }).matched, false)
  assert.equal(evaluateMonitoringRule(plan.rules[2], { ...strong, price: 54 }, { now: now + 30000, previous: first }).matchedSince, 0)
})

test('卡片只展示监控动作，不显示无关加仓价；提醒必须有实际触发记录', () => {
  const alerts = monitoringAlerts({ holding: [{ code: '002475' }] }, '002475', advice, now)
  const waiting = monitoringView(advice, { quote, alerts, now, holdQty: 1, sellableTodayQty: 1 })
  assert.equal(waiting.action, '继续持有')
  assert.deepEqual(waiting.levels, [])
  assert.equal(waiting.actionable, false)
  const hit = trackedRuleHit(alerts[0], { ...quote, price: 53.9 }, now)
  assert.match(hit, /54元/)
  Object.assign(alerts[0], { triggeredAt: now, phase: 'triggered', triggeredMsg: hit, enabled: false })
  const triggered = monitoringView(advice, { quote, alerts, now, holdQty: 1, sellableTodayQty: 1 })
  assert.equal(triggered.action, '清仓')
  assert.equal(triggered.quantity, '1手')
  assert.equal(monitoringView(advice, { quote, alerts, now, holdQty: 1, sellableTodayQty: 0 }).actionable, false)
})
