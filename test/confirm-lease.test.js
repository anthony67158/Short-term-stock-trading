import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireConfirmationLease,
  isAuthoritativeWatchingAlert,
  ownsConfirmationLease,
} from '../api/_confirm_lease.js'

function fakeAccountStore() {
  let revision = 1
  let account = {
    nick: '测试账号',
    _storageEtag: String(revision),
    data: {
      alerts: [{
        id: 'alert-1',
        code: '600519',
        enabled: true,
        phase: 'watching',
        judgeContext: { planId: 'plan-1' },
      }],
    },
  }
  return {
    async readAccount() {
      return structuredClone(account)
    },
    async writeAccount(next) {
      if (next._storageEtag !== String(revision)) {
        const error = new Error('conflict')
        error.code = 'OSS_WRITE_CONFLICT'
        throw error
      }
      revision++
      account = {
        ...structuredClone(next),
        _storageEtag: String(revision),
      }
      return structuredClone(account)
    },
  }
}

test('同账号同预警只能有一个确认执行者持有租约', async () => {
  const store = fakeAccountStore()
  const requestedAlert = {
    id: 'alert-1',
    code: '600519',
    judgeContext: { planId: 'plan-1' },
  }
  const input = {
    nick: '测试账号',
    alertId: 'alert-1',
    requestedAlert,
    ...store,
    now: 1000,
  }

  const [first, second] = await Promise.all([
    acquireConfirmationLease(input),
    acquireConfirmationLease(input),
  ])

  const winner = first.acquired ? first : second
  const loser = first.acquired ? second : first
  assert.equal(winner.acquired, true)
  assert.equal(loser.acquired, false)
  await winner.release()
  const third = await acquireConfirmationLease({ ...input, now: 2000 })
  assert.equal(third.acquired, true)
  await third.release()
})

test('拿到租约后仍须确认权威预警处于同一观察计划', () => {
  const data = {
    alerts: [{
      id: 'alert-1',
      code: '600519',
      enabled: true,
      phase: 'watching',
      judgeContext: { planId: 'plan-1' },
    }],
  }

  assert.equal(isAuthoritativeWatchingAlert(data, data.alerts[0]), true)
  assert.equal(isAuthoritativeWatchingAlert(data, {
    ...data.alerts[0],
    judgeContext: { planId: 'plan-old' },
  }), false)
  assert.equal(isAuthoritativeWatchingAlert({
    alerts: [{ ...data.alerts[0], phase: 'confirmed', enabled: false }],
  }, data.alerts[0]), false)
})

test('过期租约被新执行者接管后旧执行者不能释放新租约', async () => {
  const store = fakeAccountStore()
  const requestedAlert = {
    id: 'alert-1',
    code: '600519',
    judgeContext: { planId: 'plan-1' },
  }
  const base = {
    nick: '测试账号',
    alertId: 'alert-1',
    requestedAlert,
    ttlMs: 100,
    ...store,
  }

  const first = await acquireConfirmationLease({ ...base, now: 1000 })
  const second = await acquireConfirmationLease({ ...base, now: 1200 })
  await first.release()
  const third = await acquireConfirmationLease({ ...base, now: 1201 })
  const current = await store.readAccount()

  assert.equal(first.acquired, true)
  assert.equal(second.acquired, true)
  assert.equal(third.acquired, false)
  assert.equal(
    ownsConfirmationLease(current.data, 'alert-1', second.owner, 1201),
    true,
  )
  await second.release()
})
