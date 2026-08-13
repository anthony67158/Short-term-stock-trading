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
