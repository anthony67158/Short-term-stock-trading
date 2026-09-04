import test from 'node:test'
import assert from 'node:assert/strict'

import { __test } from '../api/cron_alert.js'
import { sha } from '../api/account.js'

function memoryStorage(account) {
  const current = `accounts/${sha('u:' + account.nick)}/current.json`
  const values = new Map([[current, structuredClone(account)]])
  return {
    async readJson(path) {
      return values.has(path) ? structuredClone(values.get(path)) : null
    },
    async list({ prefix }) {
      return {
        blobs: [...values.keys()]
          .filter((pathname) => pathname.startsWith(prefix))
          .map((pathname) => ({ pathname, uploadedAt: new Date().toISOString() })),
      }
    },
    async put(path, body) {
      values.set(path, JSON.parse(body))
      return { pathname: path }
    },
    async del(path) {
      values.delete(path)
    },
    current() {
      return values.get(current)
    },
  }
}

test('Judge维持意见会终结当前价格触发而不是继续循环复核', () => {
  const outcome = __test.terminalWaitOutcome(
    {
      id: 'buy-watch-1',
      code: '600000',
      name: '浦发银行',
      type: 'price',
      op: 'gte',
      value: 10,
      note: '买入点',
      phase: 'watching',
      enabled: true,
    },
    { price: 10.02 },
    {
      decision: 'wait',
      terminalInstruction: '维持观望；本次触发结束，不新增复核价',
      side: 'buy',
    },
    2000,
  )

  assert.equal(outcome.alert.phase, 'reviewed')
  assert.equal(outcome.alert.enabled, false)
  assert.equal(outcome.alert.triggeredAt, 2000)
  assert.equal(outcome.alert.decisionPrice, 10.02)
  assert.match(outcome.notification.title, /本次不买入/)
  assert.doesNotMatch(outcome.notification.body, /维持观望|不操作/)
  assert.doesNotMatch(outcome.notification.body, /本次触发结束|不新增复核价/)
  assert.equal(outcome.notification.silent, true)
})

test('FC回写预警状态时保留期间刚变化的持仓和新预警', async () => {
  const latest = {
    nick: '并发预警账号',
    data: {
      holding: [{ id: 'new-position', code: '000001', qty: 2 }],
      alerts: [
        { id: 'a1', enabled: true, phase: 'armed' },
        { id: 'new-alert', enabled: true, type: 'pct' },
      ],
      pushSubs: [{ endpoint: 'live' }],
      decisionLog: [],
    },
  }
  const storage = memoryStorage(latest)
  const processed = {
    nick: latest.nick,
    data: {
      holding: [{ id: 'old-position', code: '000001', qty: 1 }],
      alerts: [{
        id: 'a1',
        enabled: false,
        phase: 'invalid',
        retiredAt: 300,
        retiredPolicy: 'position-missing',
      }],
      pushSubs: [{ endpoint: 'live' }],
      decisionLog: [],
    },
  }

  await __test.persistProcessedAccount(processed, [], storage)

  const saved = storage.current()
  assert.deepEqual(saved.data.holding, latest.data.holding)
  assert.equal(saved.data.alerts.find((alert) => alert.id === 'a1').enabled, false)
  assert.equal(saved.data.alerts.some((alert) => alert.id === 'new-alert'), true)
})

test('FC回写Judge确认时只持久化确定性事件不重复排队军师', async () => {
  const latest = {
    nick: '军师闭环账号',
    data: {
      holding: [{ id: 'h1', code: '600000', name: '浦发银行', qty: 2 }],
      alerts: [{ id: 'a1', code: '600000', enabled: true, phase: 'watching' }],
      advice: {
        '600000': {
          mode: 'hold_advice',
          advice: { continuity: { planId: 'plan-1', revision: 2 } },
        },
      },
      pushSubs: [],
      decisionLog: [],
    },
  }
  const storage = memoryStorage(latest)
  const alert = {
    id: 'a1',
    code: '600000',
    name: '浦发银行',
    enabled: false,
    phase: 'confirmed',
    triggeredAt: 3000,
    judgeContext: { planId: 'plan-1', planRevision: 2 },
  }

  const persisted = await __test.persistProcessedAccount({
    nick: latest.nick,
    data: {
      ...latest.data,
      alerts: [alert],
    },
  }, [], storage, [{
    alert,
    verdict: {
      decision: 'confirm',
      confidence: 86,
      reason: '放量突破确认',
      side: 'sell',
    },
    at: 3000,
  }])

  const saved = storage.current()
  assert.equal(persisted.adviceQueued, 0)
  assert.equal(persisted.workerNeeded, false)
  assert.equal(saved.data.jobs, undefined)
  assert.equal(saved.data.executionEventState.history.length, 1)
  assert.equal(
    saved.data.executionEventState.history[0].planId,
    'plan-1',
  )
})

test('FC回写观察价命中时持久化复核任务并请求Worker接力', async () => {
  const latest = {
    nick: '观察价复核账号',
    data: {
      holding: [],
      plan: [{ code: '600519', name: '贵州茅台' }],
      alerts: [{
        id: 'review-price-1',
        code: '600519',
        candCode: '600519',
        reviewOnly: true,
        enabled: true,
        phase: 'armed',
      }],
      advice: {
        '600519': {
          mode: 'buy_advice',
          advice: {
            continuity: { planId: 'plan-watch', revision: 3 },
          },
        },
      },
      pushSubs: [],
      decisionLog: [],
    },
  }
  const storage = memoryStorage(latest)
  const alert = {
    ...latest.data.alerts[0],
    enabled: false,
    phase: 'reviewing',
    triggeredAt: 3000,
    decisionPrice: 145.3,
    value: 145.24,
    op: 'gte',
    judgeContext: { planId: 'plan-watch', planRevision: 3 },
  }

  const persisted = await __test.persistProcessedAccount({
    nick: latest.nick,
    data: {
      ...latest.data,
      alerts: [alert],
    },
  }, [], storage, [{
    kind: 'price-review',
    alert,
    at: 3000,
  }])

  const saved = storage.current()
  assert.equal(persisted.adviceQueued, 1)
  assert.equal(persisted.workerNeeded, true)
  assert.equal(saved.data.reviewJobs['600519'].source, 'judge')
  assert.equal(
    saved.data.reviewJobs['600519'].trigger.kind,
    'price-review',
  )
})

test('FC只接受当前租约owner的Judge结果并在落盘时清除租约', async () => {
  const latest = {
    nick: 'Judge租约账号',
    data: {
      alerts: [{
        id: 'a1',
        code: '600000',
        enabled: true,
        phase: 'watching',
        watchingAt: 1000,
        confirmLease: {
          owner: 'current-owner',
          acquiredAt: Date.now() - 1000,
          expiresAt: Date.now() + 60000,
        },
      }],
      pushSubs: [],
      decisionLog: [],
    },
  }
  const storage = memoryStorage(latest)
  const confirmed = {
    id: 'a1',
    code: '600000',
    enabled: false,
    phase: 'confirmed',
    watchingAt: 1000,
    lastJudgeAt: 2000,
    triggeredAt: 2000,
  }

  const rejected = await __test.persistProcessedAccount({
    nick: latest.nick,
    data: {
      ...latest.data,
      alerts: [confirmed],
      decisionLog: [{ id: 'judge:a1', alertId: 'a1', at: 2000 }],
    },
  }, [], storage, [], new Map([['a1', 'stale-owner']]))

  assert.deepEqual(rejected.acceptedLeaseIds, [])
  assert.equal(storage.current().data.alerts[0].phase, 'watching')
  assert.equal(storage.current().data.decisionLog.length, 0)

  const accepted = await __test.persistProcessedAccount({
    nick: latest.nick,
    data: {
      ...latest.data,
      alerts: [confirmed],
      decisionLog: [{ id: 'judge:a1', alertId: 'a1', at: 2000 }],
    },
  }, [], storage, [], new Map([['a1', 'current-owner']]))

  assert.deepEqual(accepted.acceptedLeaseIds, ['a1'])
  assert.equal(storage.current().data.alerts[0].phase, 'confirmed')
  assert.equal(storage.current().data.alerts[0].confirmLease, undefined)
  assert.equal(storage.current().data.decisionLog.length, 1)
})
