import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAccountMonitoring } from '../api/_monitoring.js'

const now = Date.parse('2026-09-09T02:00:00Z')
const plan = {
  schemaVersion: 'monitoring-plan.v1', planId: 'decision-1', validUntil: new Date(now + 3600000).toISOString(),
}
function account() {
  const rule = {
    id: 'rule-1', action: 'EXIT', kind: 'RISK_EXIT', lots: 1, logic: 'ANY',
    priority: 1, session: 'CONTINUOUS', sustainSeconds: 0,
    conditions: [{ metric: 'price', op: 'lte', value: 54 }, { metric: 'mainNetYi', op: 'lte', value: -3 }],
  }
  return {
    nick: '测试账号',
    data: {
      account: { simulation: true },
      holding: [{ id: 'h1', code: '002475', name: '立讯精密', qty: 1, buyPrice: 54.165, buyAt: now - 86400000 }],
      closed: [], plan: [], pushSubs: [{ endpoint: 'test' }],
      settings: { aiAutoAlert: true },
      advice: { '002475': { mode: 'hold_advice', advice: {
        monitoringPlan: plan, decisionSource: { engine: 'V3' },
        decisionPlan: { decisionId: plan.planId },
      } } },
      alerts: [{
        id: 'monitor:decision-1:rule-1', code: '002475', name: '立讯精密',
        type: 'plan-condition', actCode: '002475', actKind: 'reduce',
        enabled: true, phase: 'armed', monitoringPlanId: plan.planId,
        decisionEngine: 'V3', decisionId: plan.planId,
        validUntil: plan.validUntil, planRule: rule,
      }],
    },
  }
}
const quote = (patch = {}) => ({
  code: '002475', price: 55.07, mainInflow: -1e8, prevClose: 54.16, open: 54.2,
  tradeDate: '2026-09-09', isLivePrice: true, priceStatus: 'LIVE', ...patch,
})

test('服务端先持久化复合条件终态再发送同源通知', async () => {
  const acc = account()
  const order = []
  const result = await evaluateAccountMonitoring(acc, {
    now, quoteReader: async () => [quote({ mainInflow: -3.1e8 })],
    save: async () => { order.push('save') },
    push: async (_subs, notification) => { order.push('push'); assert.match(notification.title, /清仓1手/) },
  })
  assert.deepEqual(order, ['save', 'push'])
  assert.equal(result.triggered, 1)
  assert.equal(acc.data.alerts[0].phase, 'triggered')
  assert.equal(acc.data.alerts[0].decisionLots, 1)
  assert.match(acc.data.alerts[0].triggeredMsg, /-3亿元/)
})

test('条件未命中只更新监控状态，不推送也不改变持仓', async () => {
  const acc = account()
  let pushes = 0
  const result = await evaluateAccountMonitoring(acc, {
    now, quoteReader: async () => [quote()],
    save: async () => {},
    push: async () => { pushes++ },
  })
  assert.equal(result.triggered, 0)
  assert.equal(pushes, 0)
  assert.equal(acc.data.alerts[0].phase, 'armed')
  assert.equal(acc.data.holding[0].qty, 1)
})

test('T+1锁定时记录条件已满足但不发错误清仓指令', async () => {
  const acc = account()
  acc.data.holding[0].buyAt = now
  acc.data.closed = [{
    id: 'buy-today', code: '002475', type: 'BUY', qty: 1, price: 54,
    at: now - 1000, tradeDate: '2026-09-09',
  }]
  let pushes = 0
  await evaluateAccountMonitoring(acc, {
    now, quoteReader: async () => [quote({ price: 53.9 })],
    save: async () => {},
    push: async () => { pushes++ },
  })
  assert.equal(pushes, 0)
  assert.equal(acc.data.alerts[0].enabled, true)
  assert.equal(acc.data.alerts[0].ruleState.state, 'T1_LOCKED')
})

test('旧军师监控不绕过V3版本校验而继续推送', async () => {
  const acc = account()
  delete acc.data.advice['002475'].advice.decisionSource
  let pushes = 0
  const result = await evaluateAccountMonitoring(acc, {
    now, quoteReader: async () => [quote({ price: 53 })],
    save: async () => {},
    push: async () => { pushes++ },
  })
  assert.equal(result.triggered, 0)
  assert.equal(pushes, 0)
  assert.equal(acc.data.alerts[0].enabled, false)
  assert.equal(acc.data.alerts[0].phase, 'superseded')
})
