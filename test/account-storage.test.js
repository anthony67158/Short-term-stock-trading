import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyClientAccountSave,
  deactivateAccount,
  deactivateStoredAccount,
  isAccountActive,
  listAllAccounts,
  readAccount,
  sha,
  writeAccount,
} from '../api/account.js'

function fakeStorage() {
  const objects = new Map()
  let seq = 0
  return {
    objects,
    async put(pathname, body, options = {}) {
      const key = options.addRandomSuffix
        ? pathname.replace(/\.json$/, `-${++seq}.json`)
        : pathname
      objects.set(key, {
        value: JSON.parse(String(body)),
        uploadedAt: new Date(Date.now() + seq).toISOString(),
      })
      return { pathname: key, url: key, downloadUrl: key }
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      return {
        blobs: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit)
          .map(([pathname, item]) => ({
            pathname,
            url: pathname,
            downloadUrl: pathname,
            uploadedAt: item.uploadedAt,
            size: JSON.stringify(item.value).length,
          })),
      }
    },
    async del(pathname) {
      objects.delete(pathname)
    },
    async readJson(blobOrPath) {
      const key = typeof blobOrPath === 'string' ? blobOrPath : blobOrPath?.pathname
      return objects.get(key)?.value || null
    },
  }
}

test('账号保存同时写入 OSS 当前快照和可恢复历史快照并可立即读回', async () => {
  const storage = fakeStorage()
  const account = {
    nick: '测试账号',
    pwHash: 'hash',
    createdAt: 1,
    data: { plan: [{ code: '600519', name: '贵州茅台' }], holding: [], closed: [] },
  }

  const saved = await writeAccount(account, storage)
  const keys = [...storage.objects.keys()]
  const currentKey = keys.find((key) => key.endsWith('/current.json'))
  const historyKey = keys.find((key) => key.includes('/history/'))

  assert.ok(currentKey)
  assert.ok(historyKey)
  assert.equal(saved.storage, 'oss')
  assert.equal(saved.snapshotKey, historyKey)
  assert.deepEqual((await readAccount(account.nick, storage)).data, account.data)
})

test('OSS 当前快照写后校验失败时保存必须报错', async () => {
  const storage = fakeStorage()
  storage.readJson = async () => null

  await assert.rejects(
    writeAccount({ nick: '测试账号', pwHash: 'hash', createdAt: 1, data: {} }, storage),
    /写入校验失败/,
  )
})

test('软注销只改变账号状态并完整保留 OSS 数据', () => {
  const data = { plan: [{ code: '600519' }], holding: [{ code: '000001' }] }
  const account = { nick: '测试账号', pwHash: 'hash', createdAt: 1, data }

  const deactivated = deactivateAccount(account, 123)

  assert.equal(isAccountActive(account), true)
  assert.equal(isAccountActive(deactivated), false)
  assert.equal(deactivated.status, 'deactivated')
  assert.equal(deactivated.deactivatedAt, 123)
  assert.deepEqual(deactivated.data, data)
})

test('定时任务账号列表排除已注销账号但 OSS 中仍可直接读取', async () => {
  const storage = fakeStorage()
  await writeAccount({ nick: '正常账号', pwHash: 'a', createdAt: 1, data: { plan: [] } }, storage)
  await writeAccount(deactivateAccount({
    nick: '注销账号',
    pwHash: 'b',
    createdAt: 1,
    data: { plan: [{ code: '600519' }] },
  }, 123), storage)

  const activeAccounts = await listAllAccounts(storage)
  const retained = await readAccount('注销账号', storage)

  assert.deepEqual(activeAccounts.map((item) => item.nick), ['正常账号'])
  assert.equal(retained.status, 'deactivated')
  assert.equal(retained.data.plan.length, 1)
})

test('独立 OSS 注销标记不会被旧设备的延迟保存覆盖', async () => {
  const storage = fakeStorage()
  const account = {
    nick: '并发账号',
    pwHash: 'hash',
    createdAt: 1,
    data: { plan: [{ code: '600519' }] },
  }
  await writeAccount(account, storage)
  await deactivateStoredAccount(account, storage, 123)

  // 模拟另一台设备在注销后才完成的旧快照写入。
  await writeAccount({ ...account, data: { plan: [{ code: '000001' }] } }, storage)
  const retained = await readAccount(account.nick, storage)

  assert.equal(isAccountActive(retained), false)
  assert.equal(retained.deactivatedAt, 123)
  assert.equal(retained.data.plan[0].code, '000001')
})

test('旧客户端不能覆盖更新版本的持仓和交易流水', () => {
  const account = {
    nick: '并发账号',
    clientRevision: 8,
    data: {
      plan: [{ code: '600519' }],
      holding: [{ code: '000938', qty: 3 }],
      closed: [{ id: 'trade_1', code: '000938' }],
      decisionLog: [{ id: 'exec_1', kind: 'execution', at: 1 }],
    },
  }

  const stale = applyClientAccountSave(account, {
    plan: account.data.plan,
    holding: [],
    closed: [],
    decisionLog: [],
  }, 7)

  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'ACCOUNT_VERSION_CONFLICT')
  assert.equal(account.data.holding.length, 1)
  assert.equal(account.data.closed.length, 1)
})

test('账号同时存在旧文件和新目录快照时定时任务只枚举一次', async () => {
  const storage = fakeStorage()
  const account = { nick: '重复账号', pwHash: 'hash', createdAt: 1, data: { plan: [] } }
  await writeAccount(account, storage)
  await storage.put(`accounts/${sha('u:' + account.nick)}.json`, JSON.stringify({
    ...account,
    updatedAt: 0,
  }))

  const accounts = await listAllAccounts(storage)

  assert.deepEqual(accounts.map((item) => item.nick), ['重复账号'])
})

test('同版本客户端保存成功并递增云端版本号', () => {
  const account = {
    nick: '并发账号',
    clientRevision: 8,
    data: {
      advice: {},
      adviceLog: [],
      decisionLog: [{ id: 'exec_1', kind: 'execution', at: 1 }],
    },
  }

  const result = applyClientAccountSave(account, {
    plan: [{ code: '600519' }],
    holding: [{ code: '000938', qty: 3 }],
    closed: [{ id: 'trade_1', code: '000938' }],
    adviceLog: [],
    decisionLog: [],
  }, 8)

  assert.equal(result.ok, true)
  assert.equal(account.clientRevision, 9)
  assert.equal(account.data.holding.length, 1)
  assert.equal(account.data.closed.length, 1)
  assert.equal(account.data.decisionLog.length, 1)
})

test('客户端旧预警快照不能覆盖服务端Judge确认与后验结果', () => {
  const account = {
    nick: '预警账号',
    clientRevision: 3,
    data: {
      alerts: [{
        id: 'a1',
        code: '600000',
        phase: 'confirmed',
        enabled: false,
        triggeredAt: 200,
        lastJudgeAt: 190,
        judgeOutcomes: { m5: { directionalPct: 1.2 } },
      }],
      advice: {},
      adviceLog: [],
      decisionLog: [],
    },
  }

  const result = applyClientAccountSave(account, {
    alerts: [{ id: 'a1', code: '600000', phase: 'armed', enabled: true }],
    adviceLog: [],
    decisionLog: [],
  }, 3)

  assert.equal(result.ok, true)
  assert.equal(account.data.alerts[0].phase, 'confirmed')
  assert.equal(account.data.alerts[0].enabled, false)
  assert.equal(account.data.alerts[0].judgeOutcomes.m5.directionalPct, 1.2)
})

test('客户端保存持仓时不能覆盖服务端 AI 任务队列和 Worker 锁', () => {
  const serverJobs = {
    '600000': { code: '600000', status: 'running', progressAt: 2000 },
  }
  const account = {
    clientRevision: 3,
    data: {
      holding: [],
      jobs: serverJobs,
      jobWorker: { id: 'worker-server', lockUntil: 9999 },
    },
  }

  const result = applyClientAccountSave(account, {
    holding: [{ code: '000001', qty: 1 }],
    jobs: {},
    jobWorker: { id: '', lockUntil: 0 },
  }, 3)

  assert.equal(result.ok, true)
  assert.deepEqual(account.data.jobs, serverJobs)
  assert.deepEqual(account.data.jobWorker, { id: 'worker-server', lockUntil: 9999 })
  assert.deepEqual(account.data.holding, [{ code: '000001', qty: 1 }])
})
