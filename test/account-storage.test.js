import test from 'node:test'
import assert from 'node:assert/strict'

import {
  accountClientSnapshot,
  accountSyncDelta,
  applyClientAccountSave,
  deactivateAccount,
  deactivateStoredAccount,
  isAccountActive,
  listAllAccounts,
  mergeAdviceRuntimeState,
  readAdviceRuntimeState,
  readAccount,
  sha,
  writeAdviceBatchCancellation,
  writeAdviceRuntimeState,
  writeAdviceRuntimeUpdate,
  writeAccount,
} from '../api/account.js'

test('登录快照只返回前端使用字段并排除大型后端证据', () => {
  const data = {
    plan: [{ code: '000636' }],
    holding: [],
    closed: [],
    account: { cash: 100000 },
    alerts: [],
    reviews: {},
    advice: { '000636': { at: 1 } },
    adviceLog: [],
    decisionLog: [],
    executionPlans: [],
    executionAttributions: [],
    stockNotes: {},
    sectorConceptExplanations: {},
    settings: {},
    tradeStateResetAt: 123,
    evidenceSnapshots: {
      large: { payload: 'x'.repeat(1000000) },
    },
    portfolioAnalysisHistory: [{ payload: 'large' }],
    reviewAuto: { noon: { done: true } },
  }

  const snapshot = accountClientSnapshot(data)

  assert.deepEqual(snapshot.plan, data.plan)
  assert.deepEqual(snapshot.advice, data.advice)
  assert.equal(snapshot.tradeStateResetAt, 123)
  assert.equal(snapshot.evidenceSnapshots, undefined)
  assert.equal(snapshot.portfolioAnalysisHistory, undefined)
  assert.equal(snapshot.reviewAuto, undefined)
})

function fakeStorage({ rejectIfMatch = false } = {}) {
  const objects = new Map()
  let seq = 0
  return {
    objects,
    async put(pathname, body, options = {}) {
      const key = options.addRandomSuffix
        ? pathname.replace(/\.json$/, `-${++seq}.json`)
        : pathname
      const current = objects.get(key)
      if (options.ifMatch && rejectIfMatch) {
        const error = new Error(
          'A header you provided implies functionality that is not implemented.',
        )
        error.status = 400
        error.code = 'NotImplemented'
        throw error
      }
      if (
        options.ifMatch
        && current?.etag !== options.ifMatch
      ) {
        const error = new Error('Pre condition failed')
        error.status = 412
        error.code = 'PreconditionFailed'
        throw error
      }
      if (options.forbidOverwrite && current) {
        const error = new Error('object already exists')
        error.status = 409
        error.code = 'FileAlreadyExists'
        throw error
      }
      const etag = `etag-${++seq}`
      objects.set(key, {
        value: JSON.parse(String(body)),
        uploadedAt: new Date(Date.now() + seq).toISOString(),
        etag,
      })
      return { pathname: key, url: key, downloadUrl: key, etag }
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
            etag: item.etag,
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
    async readJsonWithMeta(blobOrPath) {
      const key = typeof blobOrPath === 'string'
        ? blobOrPath
        : blobOrPath?.pathname
      const item = objects.get(key)
      return item
        ? { value: structuredClone(item.value), etag: item.etag }
        : { value: null, etag: null }
    },
  }
}

test('列举账号时OSS故障必须向上抛出而不是伪装成空账号', async () => {
  await assert.rejects(
    () => listAllAccounts({
      async list() {
        throw new Error('OSS unavailable')
      },
      async readJson() {
        return null
      },
    }),
    /OSS unavailable/,
  )
})

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

test('两个实例基于同一ETag写入时只有第一份可以覆盖权威快照', async () => {
  const storage = fakeStorage()
  await writeAccount({
    nick: '并发条件写账号',
    pwHash: 'hash',
    createdAt: 1,
    clientRevision: 1,
    data: { plan: [], holding: [], closed: [] },
  }, storage)
  const first = await readAccount('并发条件写账号', storage)
  const second = await readAccount('并发条件写账号', storage)

  first.data.plan = [{ code: '600519' }]
  await writeAccount(first, storage)
  second.data.plan = [{ code: '000001' }]

  await assert.rejects(
    writeAccount(second, storage),
    (error) => error?.code === 'OSS_WRITE_CONFLICT',
  )
  const saved = await readAccount('并发条件写账号', storage)
  const listed = await listAllAccounts(storage)
  assert.equal(saved.data.plan[0].code, '600519')
  assert.equal(listed[0].data.plan[0].code, '600519')
})

test('OSS PutObject不支持If-Match时通过原子锁完成条件写', async () => {
  const storage = fakeStorage({ rejectIfMatch: true })
  await writeAccount({
    nick: 'OSS条件写兼容账号',
    pwHash: 'hash',
    createdAt: 1,
    clientRevision: 1,
    data: { plan: [], holding: [], closed: [] },
  }, storage)
  const account = await readAccount('OSS条件写兼容账号', storage)
  account.data.plan = [{ code: '600519' }]

  await writeAccount(account, storage)

  const saved = await readAccount('OSS条件写兼容账号', storage)
  assert.equal(saved.data.plan[0].code, '600519')
})

test('同一服务端实例连续保存会推进ETag而不是误报冲突', async () => {
  const storage = fakeStorage()
  await writeAccount({
    nick: '连续写账号',
    pwHash: 'hash',
    createdAt: 1,
    data: { plan: [], holding: [], closed: [] },
  }, storage)
  const account = await readAccount('连续写账号', storage)

  account.data.plan = [{ code: '600519' }]
  await writeAccount(account, storage)
  account.data.plan.push({ code: '000001' })
  await writeAccount(account, storage)

  const saved = await readAccount('连续写账号', storage)
  assert.deepEqual(
    saved.data.plan.map((item) => item.code),
    ['600519', '000001'],
  )
})

test('Worker运行态保存只覆盖当前快照且不生成历史或回读校验', async () => {
  const storage = fakeStorage()
  let reads = 0
  const originalRead = storage.readJson
  storage.readJson = async (...args) => {
    reads += 1
    return originalRead(...args)
  }
  const account = {
    nick: '运行态账号',
    pwHash: 'hash',
    createdAt: 1,
    data: { jobs: { '600000': { progressAt: 200 } } },
  }

  const saved = await writeAccount(account, storage, {
    history: false,
    verify: false,
  })
  const keys = [...storage.objects.keys()]

  assert.equal(keys.filter((key) => key.endsWith('/current.json')).length, 1)
  assert.equal(keys.some((key) => key.includes('/history/')), false)
  assert.equal(reads, 0)
  assert.equal(saved.snapshotKey, null)
})

test('单股建议完成后通过独立OSS小对象立即进入跨设备增量同步', async () => {
  const storage = fakeStorage()
  const account = {
    nick: '增量账号',
    pwHash: 'hash',
    createdAt: 1,
    updatedAt: 100,
    data: {
      plan: [{ code: '600519', name: '贵州茅台' }],
      holding: [],
      closed: [],
      advice: {},
      jobs: {},
    },
  }
  const saved = await writeAccount(account, storage, {
    history: false,
    verify: false,
  })
  const stateAt = saved.updatedAt + 10
  const adviceAt = saved.updatedAt + 20
  await writeAdviceRuntimeState(account.nick, {
    updatedAt: stateAt,
    jobs: {
      '600519': {
        id: 'job-1',
        code: '600519',
        status: 'done',
        finishedAt: stateAt,
        progressAt: stateAt,
      },
    },
    batchProgress: { at: stateAt, done: 1, total: 2 },
  }, storage)
  await writeAdviceRuntimeUpdate(account.nick, {
    code: '600519',
    updatedAt: adviceAt,
    advice: {
      at: adviceAt,
      advice: { action: '持有', title: '继续持有' },
    },
    job: {
      id: 'job-1',
      code: '600519',
      status: 'done',
      finishedAt: stateAt,
      progressAt: stateAt,
    },
    batchProgress: { at: adviceAt, done: 1, total: 2 },
  }, storage)

  const rawCurrent = storage.objects.get(
    `accounts/${sha('u:增量账号')}/current.json`,
  )?.value
  assert.deepEqual(rawCurrent.data.advice, {})

  const hydrated = await readAccount(account.nick, storage)
  assert.equal(hydrated.data.advice['600519'].advice.title, '继续持有')
  assert.equal(hydrated.data.jobs['600519'].status, 'done')
  assert.equal(hydrated.data.batchProgress.done, 1)
  assert.equal(hydrated.updatedAt, adviceAt)
  assert.equal(
    accountSyncDelta(hydrated.data, saved.updatedAt).advice['600519']
      .advice.title,
    '继续持有',
  )
  const overlapped = await readAccount(account.nick, storage, {
    runtimeSince: adviceAt + 10,
  })
  assert.equal(
    overlapped.data.advice['600519'].advice.title,
    '继续持有',
  )
  assert.deepEqual(
    (await listAllAccounts(storage)).map((item) => item.nick),
    ['增量账号'],
  )
})

test('轻量运行态可直接携带完成建议而无需等待主快照压实', () => {
  const account = {
    updatedAt: 100,
    data: {
      advice: {},
      jobWorker: {
        id: 'worker-old',
        lockUntil: 9999,
      },
      jobs: {
        '600519': {
          id: 'job-1',
          code: '600519',
          status: 'running',
          progressAt: 100,
        },
      },
    },
  }
  const adviceAt = 200

  mergeAdviceRuntimeState(account, {
    updatedAt: adviceAt,
    jobWorker: null,
    jobs: {
      '600519': {
        id: 'job-1',
        code: '600519',
        status: 'done',
        finishedAt: adviceAt,
        progressAt: adviceAt,
      },
    },
    recentAdviceUpdates: [{
      schemaVersion: 'advice-runtime-update.v2',
      code: '600519',
      role: 'advisor',
      jobKey: 'advisor:600519',
      updatedAt: adviceAt,
      advice: {
        at: adviceAt,
        advice: { action: '持有', title: '继续持有' },
      },
      job: {
        id: 'job-1',
        code: '600519',
        status: 'done',
        finishedAt: adviceAt,
        progressAt: adviceAt,
      },
    }],
  })

  assert.equal(account.data.jobs['600519'].status, 'done')
  assert.equal(account.data.jobWorker, null)
  assert.equal(
    account.data.advice['600519'].advice.title,
    '继续持有',
  )
})

test('并发轻量运行态写入会合并任务而不是后写覆盖', async () => {
  const storage = fakeStorage()
  const nick = '运行态并发账号'
  const advisorJob = {
    id: 'advisor-1',
    code: '600519',
    status: 'queued',
    at: 100,
    progressAt: 100,
  }
  const reviewJob = {
    id: 'review-1',
    code: '000001',
    role: 'review',
    status: 'queued',
    at: 101,
    progressAt: 101,
  }

  await Promise.all([
    writeAdviceRuntimeState(nick, {
      updatedAt: 100,
      jobs: { '600519': advisorJob },
      recentAdviceUpdates: [],
    }, storage),
    writeAdviceRuntimeState(nick, {
      updatedAt: 101,
      reviewJobs: { '000001': reviewJob },
      recentAdviceUpdates: [],
    }, storage),
  ])

  const runtime = await readAdviceRuntimeState(nick, storage)
  assert.equal(runtime.jobs['600519'].id, 'advisor-1')
  assert.equal(runtime.reviewJobs['000001'].id, 'review-1')
})

test('运行态游标已前移时仍合并迟到的完成建议', () => {
  const account = {
    updatedAt: 300,
    data: {
      runtimeStateAppliedAt: 300,
      runtimeAdviceAppliedAt: {},
      advice: {},
      jobs: {},
    },
  }

  mergeAdviceRuntimeState(account, {
    updatedAt: 300,
    recentAdviceUpdates: [{
      code: '600519',
      role: 'advisor',
      jobKey: 'advisor:600519',
      updatedAt: 250,
      advice: {
        at: 250,
        advice: { action: '持有', title: '迟到建议仍需送达' },
      },
    }],
  })

  assert.equal(
    account.data.advice['600519'].advice.title,
    '迟到建议仍需送达',
  )
})

test('全部停止指令不会被迟到的Worker运行快照覆盖', async () => {
  const storage = fakeStorage()
  const nick = '批量取消并发账号'
  const batchId = 'batch-cancel-32'
  const jobs = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => {
      const code = String(600000 + index)
      return [code, {
        id: `job-${index}`,
        code,
        batchId,
        status: 'running',
        at: 1000 + index,
        progressAt: 2000 + index,
      }]
    }),
  )
  const items = Object.values(jobs).map((job) => ({
    code: job.code,
    jobId: job.id,
    batchId,
    status: 'running',
  }))
  const account = await writeAccount({
    nick,
    pwHash: 'hash',
    createdAt: 1,
    data: {
      plan: [],
      holding: [],
      closed: [],
      jobs,
      activeAdviceBatchId: batchId,
    },
  }, storage, {
    history: false,
    verify: false,
  })
  const stateAt = account.updatedAt + 10
  const activeState = {
    schemaVersion: 'advice-runtime-state.v2',
    updatedAt: stateAt,
    jobs,
    activeAdviceBatchId: batchId,
    batchProgress: {
      batchId,
      running: true,
      total: 32,
      done: 0,
      skipped: 0,
      at: stateAt,
      items,
    },
  }

  await writeAdviceRuntimeState(nick, activeState, storage)
  const cancellation = await writeAdviceBatchCancellation(nick, {
    batchId,
    canceledAt: stateAt + 10,
  }, storage)
  const retriedCancellation = await writeAdviceBatchCancellation(nick, {
    batchId,
    canceledAt: stateAt + 50,
  }, storage)
  assert.equal(
    retriedCancellation.canceledAt,
    cancellation.canceledAt,
  )
  const lateUpdate = {
    schemaVersion: 'advice-runtime-update.v2',
    code: '600000',
    role: 'advisor',
    jobKey: 'advisor:600000',
    updatedAt: stateAt + 30,
    advice: {
      at: stateAt + 30,
      advice: { action: '买入', title: '取消后不得发布' },
    },
    job: {
      ...jobs['600000'],
      status: 'done',
      finishedAt: stateAt + 30,
      progressAt: stateAt + 30,
    },
  }
  await writeAdviceRuntimeState(nick, {
    ...activeState,
    updatedAt: stateAt + 20,
    batchProgress: {
      ...activeState.batchProgress,
      at: stateAt + 20,
    },
    recentAdviceUpdates: [lateUpdate],
  }, storage)
  await writeAdviceRuntimeUpdate(nick, lateUpdate, storage)

  const runtime = await readAdviceRuntimeState(nick, storage)
  assert.equal(
    Object.values(runtime.jobs)
      .every((job) => job.status === 'canceled'),
    true,
  )

  const hydrated = await readAccount(nick, storage)
  assert.equal(
    Object.values(hydrated.data.jobs)
      .every((job) => job.status === 'canceled'),
    true,
  )
  assert.equal(hydrated.data.batchProgress.running, false)
  assert.equal(hydrated.data.batchProgress.done, 32)
  assert.equal(hydrated.data.batchProgress.skipped, 32)
  assert.equal(hydrated.data.advice?.['600000'], undefined)

  const doneJobs = Object.fromEntries(
    Object.entries(jobs).map(([code, job]) => [code, {
      ...job,
      status: 'done',
      finishedAt: stateAt + 40,
      progressAt: stateAt + 40,
    }]),
  )
  await writeAdviceRuntimeState(nick, {
    ...activeState,
    updatedAt: stateAt + 40,
    jobs: doneJobs,
    batchProgress: {
      ...activeState.batchProgress,
      running: false,
      done: 32,
      at: stateAt + 40,
      items: activeState.batchProgress.items.map((item) => ({
        ...item,
        status: 'ok',
      })),
    },
  }, storage)
  const terminalHydrated = await readAccount(nick, storage, {
    includeAdviceUpdates: false,
  })
  assert.equal(
    Object.values(terminalHydrated.data.jobs)
      .every((job) => job.status === 'canceled'),
    true,
  )
})

test('并发全部停止通过原子锁避免取消截止线相互覆盖', async () => {
  const storage = fakeStorage()
  const nick = '并发取消锁账号'
  const requests = [
    { batchId: 'batch-a', canceledAt: 1000 },
    { batchId: 'batch-b', canceledAt: 2000 },
  ]
  const results = await Promise.allSettled(
    requests.map((request) =>
      writeAdviceBatchCancellation(nick, request, storage)
    ),
  )
  const rejectedIndex = results.findIndex(
    (result) => result.status === 'rejected',
  )
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.notEqual(rejectedIndex, -1)
  await writeAdviceBatchCancellation(
    nick,
    requests[rejectedIndex],
    storage,
  )

  const latest = storage.objects.get(
    `accounts/${sha(`u:${nick}`)}/runtime/cancellations/latest.json`,
  )?.value
  assert.equal(latest.cancelBefore, 2000)
  assert.deepEqual(latest.batchCancellations, {
    'batch-a': 1000,
    'batch-b': 2000,
  })
})

test('同股advisor与review增量使用独立OSS对象并分别合并', async () => {
  const storage = fakeStorage()
  const account = await writeAccount({
    nick: '双队列账号',
    pwHash: 'hash',
    createdAt: 1,
    clientRevision: 1,
    data: {
      plan: [],
      holding: [{ code: '600519', name: '贵州茅台' }],
      closed: [],
      advice: {},
      jobs: {},
      reviewJobs: {},
    },
  }, storage, {
    history: false,
    verify: false,
  })

  await writeAdviceRuntimeUpdate(account.nick, {
    schemaVersion: 'advice-runtime-update.v2',
    code: '600519',
    role: 'advisor',
    jobKey: 'advisor:600519',
    updatedAt: account.updatedAt + 10,
    job: {
      id: 'advisor-1',
      code: '600519',
      role: 'advisor',
      status: 'done',
      progressAt: account.updatedAt + 10,
    },
  }, storage)
  await writeAdviceRuntimeUpdate(account.nick, {
    schemaVersion: 'advice-runtime-update.v2',
    code: '600519',
    role: 'review',
    jobKey: 'review:600519',
    updatedAt: account.updatedAt + 20,
    reviewJob: {
      id: 'review-1',
      code: '600519',
      role: 'review',
      status: 'done',
      progressAt: account.updatedAt + 20,
    },
  }, storage)

  const prefix = `accounts/${sha('u:双队列账号')}/runtime/advice/`
  assert.equal(storage.objects.has(`${prefix}600519.json`), true)
  assert.equal(storage.objects.has(`${prefix}review-600519.json`), true)

  const hydrated = await readAccount(account.nick, storage)
  assert.equal(hydrated.data.jobs['600519'].id, 'advisor-1')
  assert.equal(hydrated.data.reviewJobs['600519'].id, 'review-1')
})

test('迟到上传的单股建议不能被较新的运行态游标永久跳过', async () => {
  const storage = fakeStorage()
  const account = await writeAccount({
    nick: '乱序增量账号',
    pwHash: 'hash',
    createdAt: 1,
    clientRevision: 1,
    data: {
      plan: [{ code: '600519', name: '贵州茅台' }],
      holding: [],
      closed: [],
      advice: {},
      jobs: {},
    },
  }, storage, {
    history: false,
    verify: false,
  })
  const stateAt = account.updatedAt + 1
  await writeAdviceRuntimeState(account.nick, {
    updatedAt: stateAt,
    jobs: {
      '600519': {
        id: 'job-late',
        code: '600519',
        status: 'running',
        progressAt: stateAt,
      },
    },
  }, storage)

  const firstPull = await readAccount(account.nick, storage, {
    runtimeSince: account.updatedAt,
  })
  const cursor = firstPull.updatedAt
  assert.equal(firstPull.data.advice['600519'], undefined)

  await writeAdviceRuntimeUpdate(account.nick, {
    code: '600519',
    updatedAt: stateAt,
    advice: {
      at: stateAt,
      advice: { action: '持有', title: '迟到但必须送达的建议' },
    },
    job: {
      id: 'job-late',
      code: '600519',
      status: 'done',
      progressAt: stateAt,
      finishedAt: stateAt,
    },
  }, storage)

  const secondPull = await readAccount(account.nick, storage, {
    runtimeSince: cursor,
  })
  const changed = Number(secondPull.updatedAt) > cursor
  const delta = changed
    ? accountSyncDelta(secondPull.data, cursor)
    : {}

  assert.equal(changed, true)
  assert.equal(
    delta.advice['600519'].advice.title,
    '迟到但必须送达的建议',
  )
})

test('运行时账号同步只返回更新时间后的建议事件和轻量状态', () => {
  const delta = accountSyncDelta({
    advice: {
      old: { at: 100, advice: { action: '持有' } },
      fresh: { at: 300, advice: { action: '减仓' } },
    },
    adviceLog: [
      { id: 'old-log', at: 100 },
      { id: 'verified-log', at: 100, verifiedAt: 350 },
    ],
    decisionLog: [
      { id: 'old-decision', at: 100 },
      { id: 'executed', at: 100, executedAt: 360 },
    ],
    reviews: {
      old: { code: 'old', at: 100, session: 'noon' },
      fresh: { code: 'fresh', at: 370, session: 'close' },
    },
    alerts: [{ id: 'a1', createdAt: 50 }],
    batchProgress: { at: 400, running: true },
    executionPlans: [
      { planId: 'old-plan', updatedAt: 100 },
      { planId: 'fresh-plan', updatedAt: 420 },
    ],
    executionAttributions: [
      { planId: 'old-plan', updatedAt: 100 },
      { planId: 'fresh-plan', updatedAt: 430 },
    ],
    tradeStateResetAt: 450,
    holding: [{ code: '600000', qty: 2 }],
    closed: [{ id: 'trade-1' }],
  }, 200)

  assert.deepEqual(Object.keys(delta.advice), ['fresh'])
  assert.deepEqual(delta.adviceLog.map((item) => item.id), ['verified-log'])
  assert.deepEqual(delta.decisionLog.map((item) => item.id), ['executed'])
  assert.deepEqual(Object.keys(delta.reviews), ['fresh'])
  assert.equal(delta.alerts.length, 1)
  assert.equal(delta.batchProgress.running, true)
  assert.deepEqual(
    delta.executionPlans.map((item) => item.planId),
    ['fresh-plan'],
  )
  assert.deepEqual(
    delta.executionAttributions.map((item) => item.planId),
    ['fresh-plan'],
  )
  assert.equal(delta.tradeStateResetAt, 450)
  assert.equal(delta.holding, undefined)
  assert.equal(delta.closed, undefined)
})

test('委员会复核期间同步游标前移后仍返回刚完成的建议', () => {
  const delta = accountSyncDelta({
    advice: {
      '003036': {
        at: 100,
        mode: 'buy_advice',
        advice: { action: '回调再买' },
      },
    },
    jobs: {
      '003036': {
        code: '003036',
        status: 'done',
        progressAt: 300,
        finishedAt: 300,
      },
    },
    batchProgress: {
      at: 300,
      running: false,
      items: [{ code: '003036', status: 'done' }],
    },
  }, 200)

  assert.deepEqual(Object.keys(delta.advice), ['003036'])
  assert.equal(delta.advice['003036'].advice.action, '回调再买')
})

test('客户端旧快照不能覆盖服务端复核遥测', () => {
  const account = {
    nick: 'review-metrics',
    clientRevision: 1,
    data: {
      plan: [],
      holding: [],
      closed: [],
      adviceReviewLog: [{
        id: 'review-2',
        code: '600000',
        at: 2000,
        disposition: 'material-change',
      }],
    },
  }

  const result = applyClientAccountSave(account, {
    plan: [],
    holding: [],
    closed: [],
    adviceReviewLog: [{
      id: 'review-1',
      code: '600000',
      at: 1000,
      disposition: 'unchanged',
    }],
  }, 1)

  assert.equal(result.ok, true)
  assert.deepEqual(
    account.data.adviceReviewLog.map((item) => item.id),
    ['review-2', 'review-1'],
  )
})

test('客户端保存保留服务端收益学习与事件状态并清理旧策略字段', () => {
  const account = {
    nick: '治理状态账号',
    clientRevision: 3,
    data: {
      plan: [],
      holding: [],
      closed: [],
      realOutcomeLearning: { schemaVersion: 'real-outcome-learning.v1' },
      advisorCouncilShadow: [{ at: 2, shadowOnly: true }],
      strategyHumanApproval: {
        specVersion: 'strategy.test',
        approvedAt: 1,
        approvedBy: 'owner',
      },
      strategyGovernanceV2: {
        schemaVersion: 'strategy-governance.v2',
        strategies: [{
          strategyId: 'trend-breakout',
          state: 'draft',
        }],
      },
      adviceEventKeys: {
        'judge:alert-1': 1000,
      },
    },
  }

  const applied = applyClientAccountSave(account, {
    plan: [],
    holding: [],
    closed: [],
    strategyGovernanceV2: {
      schemaVersion: 'strategy-governance.v2',
      strategies: [{
        strategyId: 'trend-breakout',
        state: 'active',
      }],
    },
    adviceEventKeys: {
      'judge:forged': 2000,
    },
  }, 3)

  assert.equal(applied.ok, true)
  assert.equal(
    account.data.realOutcomeLearning.schemaVersion,
    'real-outcome-learning.v1',
  )
  assert.equal(account.data.advisorCouncilShadow.length, 1)
  assert.equal(account.data.strategyHumanApproval, undefined)
  assert.equal(account.data.strategyGovernanceV2, undefined)
  assert.deepEqual(account.data.adviceEventKeys, {
    'judge:alert-1': 1000,
  })
})

test('客户端保存按更新时间合并执行计划与成交归因', () => {
  const account = {
    nick: 'execution-merge',
    clientRevision: 4,
    data: {
      plan: [],
      holding: [],
      closed: [],
      executionPlans: [{
        schemaVersion: 'execution-plan.v1',
        planId: 'execution.shared',
        status: 'COMPLETED',
        filledLots: 2,
        transitions: [{ to: 'DRAFT' }, { to: 'COMPLETED' }],
        updatedAt: 300,
      }],
      executionAttributions: [{
        schemaVersion: 'execution-attribution.v1',
        planId: 'execution.shared',
        status: 'COMPLETED',
        totalFees: 8,
        validationComplete: true,
        learningEligible: true,
        updatedAt: 300,
      }],
    },
  }

  const applied = applyClientAccountSave(account, {
    plan: [],
    holding: [],
    closed: [],
    executionPlans: [
      {
        schemaVersion: 'execution-plan.v1',
        planId: 'execution.shared',
        status: 'ARMED',
        filledLots: 0,
        transitions: [{ to: 'DRAFT' }, { to: 'ARMED' }],
        updatedAt: 500,
      },
      {
        schemaVersion: 'execution-plan.v1',
        planId: 'execution.client',
        status: 'ARMED',
        updatedAt: 400,
      },
    ],
    executionAttributions: [{
      schemaVersion: 'execution-attribution.v1',
      planId: 'execution.shared',
      status: 'PARTIAL',
      totalFees: 5,
      validationComplete: false,
      learningEligible: false,
      updatedAt: 500,
    }],
  }, 4)

  assert.equal(applied.ok, true)
  assert.equal(account.data.executionPlans.length, 2)
  assert.equal(
    account.data.executionPlans.find(
      (plan) => plan.planId === 'execution.shared',
    ).status,
    'COMPLETED',
  )
  assert.equal(
    account.data.executionAttributions[0].totalFees,
    8,
  )
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
  await assert.rejects(
    writeAccount(
      { ...account, data: { plan: [{ code: '000001' }] } },
      storage,
    ),
    (error) => error?.code === 'OSS_WRITE_CONFLICT',
  )
  const retained = await readAccount(account.nick, storage)

  assert.equal(isAccountActive(retained), false)
  assert.equal(retained.deactivatedAt, 123)
  assert.equal(retained.data.plan[0].code, '600519')
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

test('同版本旧页面缺少已执行交易时也不能覆盖云端持仓', () => {
  const account = {
    nick: '并发账号',
    clientRevision: 8,
    data: {
      plan: [],
      holding: [{ id: 'h1', code: '600601', qty: 4, buyPrice: 12.85 }],
      closed: [{ id: 'tx1', code: '600601', type: 'BUY', qty: 4, price: 12.85 }],
      decisionLog: [{
        id: 'exec1',
        kind: 'execution',
        transactionId: 'tx1',
        code: '600601',
        side: 'buy',
        qty: 4,
        price: 12.85,
        at: 100,
      }],
    },
  }

  const result = applyClientAccountSave(account, {
    plan: [{ code: '600601' }],
    holding: [],
    closed: [],
    // 旧页面通过云端拉取拿到了执行事件，却没有合并持仓和流水。
    decisionLog: account.data.decisionLog,
  }, 8)

  assert.equal(result.ok, false)
  assert.equal(result.code, 'TRADE_STATE_CONFLICT')
  assert.equal(account.data.holding[0].qty, 4)
  assert.equal(account.data.closed[0].id, 'tx1')
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

test('客户端账本保存不删除服务端维护的Web Push订阅', () => {
  const pushSubs = [{
    endpoint: 'https://fcm.googleapis.com/fcm/send/example',
    keys: { p256dh: 'public-key', auth: 'auth-key' },
    at: 100,
  }]
  const account = {
    nick: '推送账号',
    clientRevision: 2,
    data: {
      plan: [],
      holding: [],
      closed: [],
      alerts: [],
      advice: {},
      adviceLog: [],
      decisionLog: [],
      pushSubs,
    },
  }

  const result = applyClientAccountSave(account, {
    plan: [{ code: '600519' }],
    holding: [],
    closed: [],
    alerts: [],
    advice: {},
    adviceLog: [],
    decisionLog: [],
  }, 2)

  assert.equal(result.ok, true)
  assert.deepEqual(account.data.pushSubs, pushSubs)
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
        judgeContext: { action: '加仓', addPrice: 10 },
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
  assert.deepEqual(account.data.alerts[0].judgeContext, { action: '加仓', addPrice: 10 })
})

test('客户端保存不能清除服务端尚未过期的Judge确认租约', () => {
  const now = Date.now()
  const account = {
    nick: '确认租约账号',
    clientRevision: 4,
    data: {
      alerts: [{
        id: 'lease-alert',
        code: '600000',
        phase: 'watching',
        enabled: true,
        watchingAt: now - 60000,
        confirmLease: {
          owner: 'server-owner',
          acquiredAt: now - 1000,
          expiresAt: now + 60000,
        },
      }],
      advice: {},
      adviceLog: [],
      decisionLog: [],
    },
  }

  const result = applyClientAccountSave(account, {
    alerts: [{
      id: 'lease-alert',
      code: '600000',
      phase: 'watching',
      enabled: true,
      watchingAt: now - 60000,
    }],
    adviceLog: [],
    decisionLog: [],
  }, 4)

  assert.equal(result.ok, true)
  assert.equal(account.data.alerts[0].confirmLease.owner, 'server-owner')
})

test('客户端旧预警快照不能重新启用服务端已退役的持仓预警', () => {
  const account = {
    nick: '预警退役账号',
    clientRevision: 5,
    data: {
      alerts: [{
        id: 'stale-add',
        code: '600519',
        actKind: 'add',
        phase: 'invalid',
        enabled: false,
        retiredAt: 300,
        retiredPolicy: 'position-missing',
      }],
      advice: {},
      adviceLog: [],
      decisionLog: [],
    },
  }

  const result = applyClientAccountSave(account, {
    alerts: [{
      id: 'stale-add',
      code: '600519',
      actKind: 'add',
      phase: 'watching',
      enabled: true,
      watchingAt: 200,
    }],
    adviceLog: [],
    decisionLog: [],
  }, 5)

  assert.equal(result.ok, true)
  assert.equal(account.data.alerts[0].enabled, false)
  assert.equal(account.data.alerts[0].phase, 'invalid')
  assert.equal(account.data.alerts[0].retiredPolicy, 'position-missing')
})

test('客户端旧快照不能覆盖服务端新生成的自动复盘及运行状态', () => {
  const account = {
    nick: '复盘账号',
    clientRevision: 4,
    data: {
      reviews: {
        '600001': {
          code: '600001',
          session: 'close',
          dayKey: '2026-08-13',
          at: 500,
        },
      },
      reviewAuto: {
        runs: {
          '2026-08-13:close': {
            codes: { '600001': { status: 'done', completedAt: 500 } },
          },
        },
      },
      advice: {},
      adviceLog: [],
      decisionLog: [],
    },
  }

  const result = applyClientAccountSave(account, {
    reviews: {
      '600001': {
        code: '600001',
        session: 'noon',
        dayKey: '2026-08-13',
        at: 300,
      },
    },
    reviewAuto: {},
    advice: {},
    adviceLog: [],
    decisionLog: [],
  }, 4)

  assert.equal(result.ok, true)
  assert.equal(account.data.reviews['600001'].session, 'close')
  assert.equal(account.data.reviewAuto.runs['2026-08-13:close'].codes['600001'].status, 'done')
})

test('客户端旧快照不能删除服务端证据快照索引且新增快照可合并', () => {
  const account = {
    nick: '证据账号',
    clientRevision: 5,
    data: {
      evidenceSnapshots: {
        ev_server: {
          snapshotId: 'ev_server',
          asOf: '2026-08-13T02:00:00.000Z',
        },
      },
      advice: {},
      adviceLog: [],
      decisionLog: [],
    },
  }

  const result = applyClientAccountSave(account, {
    evidenceSnapshots: {
      ev_client: {
        snapshotId: 'ev_client',
        asOf: '2026-08-13T02:01:00.000Z',
      },
    },
    advice: {},
    adviceLog: [],
    decisionLog: [],
  }, 5)

  assert.equal(result.ok, true)
  assert.deepEqual(
    Object.keys(account.data.evidenceSnapshots).sort(),
    ['ev_client', 'ev_server'],
  )
})

test('运行时增量同步不返回完整证据快照索引', () => {
  const delta = accountSyncDelta({
    evidenceSnapshots: {
      ev_large: {
        snapshotId: 'ev_large',
        asOf: '2026-08-13T02:01:00.000Z',
        evidence: { news: { headlines: ['大型证据'] } },
      },
    },
  }, 0)

  assert.equal(delta.evidenceSnapshots, undefined)
})

test('客户端不能把建仓前的买入建议重新写回当前持仓', () => {
  const account = {
    nick: '建议模式账号',
    clientRevision: 6,
    data: {
      holding: [{ id: 'h1', code: '600000', qty: 1, buyPrice: 10 }],
      advice: {},
      adviceLog: [],
      decisionLog: [],
    },
  }

  const result = applyClientAccountSave(account, {
    plan: [],
    holding: [{ id: 'h1', code: '600000', qty: 1, buyPrice: 10 }],
    closed: [],
    advice: {
      '600000': {
        mode: 'buy_advice',
        at: 300,
        advice: { action: '观望', tier: 'wait' },
      },
    },
    adviceLog: [],
    decisionLog: [],
  }, 6)

  assert.equal(result.ok, true)
  assert.equal(account.data.advice['600000'], undefined)
})

test('客户端保存持仓时不能覆盖服务端 AI 任务队列和 Worker 锁', () => {
  const serverJobs = {
    '600000': { code: '600000', status: 'running', progressAt: 2000 },
  }
  const serverReviewJobs = {
    '600000': {
      code: '600000',
      role: 'review',
      status: 'running',
      progressAt: 2100,
    },
  }
  const portfolioAnalysisJob = {
    id: 'portfolio_2000',
    status: 'running',
    updatedAt: 2000,
  }
  const portfolioAnalysisLatest = {
    id: 'portfolio_1000',
    generatedAt: 1000,
    result: { ok: true },
  }
  const portfolioAnalysisHistory = [portfolioAnalysisLatest]
  const portfolioAnalysisReview = {
    enabled: true,
    updatedAt: 2000,
  }
  const account = {
    clientRevision: 3,
    data: {
      holding: [],
      jobs: serverJobs,
      reviewJobs: serverReviewJobs,
      jobWorker: { id: 'worker-server', lockUntil: 9999 },
      activeAdviceBatchId: 'batch-server',
      adviceBatchCancellations: { 'batch-stopped': 3000 },
      adviceAutoPauseUntil: 5000,
      tradeStateResetAt: 4000,
      portfolioAnalysisJob,
      portfolioAnalysisLatest,
      portfolioAnalysisHistory,
      portfolioAnalysisReview,
    },
  }

  const result = applyClientAccountSave(account, {
    holding: [{ code: '000001', qty: 1 }],
    jobs: {},
    reviewJobs: {},
    jobWorker: { id: '', lockUntil: 0 },
    activeAdviceBatchId: 'batch-client-old',
    adviceBatchCancellations: {},
    adviceAutoPauseUntil: 0,
    tradeStateResetAt: 0,
    portfolioAnalysisJob: null,
    portfolioAnalysisLatest: null,
    portfolioAnalysisHistory: [],
    portfolioAnalysisReview: { enabled: false },
  }, 3)

  assert.equal(result.ok, true)
  assert.deepEqual(account.data.jobs, serverJobs)
  assert.deepEqual(account.data.reviewJobs, serverReviewJobs)
  assert.deepEqual(account.data.jobWorker, { id: 'worker-server', lockUntil: 9999 })
  assert.equal(account.data.activeAdviceBatchId, 'batch-server')
  assert.deepEqual(
    account.data.adviceBatchCancellations,
    { 'batch-stopped': 3000 },
  )
  assert.equal(account.data.adviceAutoPauseUntil, 5000)
  assert.equal(account.data.tradeStateResetAt, 4000)
  assert.deepEqual(
    account.data.portfolioAnalysisJob,
    portfolioAnalysisJob,
  )
  assert.deepEqual(
    account.data.portfolioAnalysisLatest,
    portfolioAnalysisLatest,
  )
  assert.deepEqual(
    account.data.portfolioAnalysisHistory,
    portfolioAnalysisHistory,
  )
  assert.deepEqual(
    account.data.portfolioAnalysisReview,
    portfolioAnalysisReview,
  )
  assert.deepEqual(account.data.holding, [{ code: '000001', qty: 1 }])
})

test('客户端保存持仓时不能清掉服务端已生成的策略日报摘要', () => {
  const adviceDailyReport = {
    summary: {
      day: '2026-08-12',
      session: 'morning',
      text: '控制仓位，等待确认。',
    },
    at: 2000,
    source: 'generated',
  }
  const account = {
    clientRevision: 3,
    data: {
      holding: [],
      adviceDailyReport,
    },
  }

  const result = applyClientAccountSave(account, {
    holding: [{ code: '000001', qty: 1 }],
  }, 3)

  assert.equal(result.ok, true)
  assert.deepEqual(account.data.adviceDailyReport, adviceDailyReport)
  assert.deepEqual(account.data.holding, [{ code: '000001', qty: 1 }])
})

test('显式冲突覆盖采用本机交易账本并取消已清仓股票的持仓任务', () => {
  const account = {
    clientRevision: 9,
    data: {
      holding: [{
        id: 'hold-fenghua',
        code: '000636',
        name: '风华高科',
        qty: 1,
      }],
      plan: [],
      closed: [],
      jobs: {
        '000636': {
          id: 'job-fenghua',
          code: '000636',
          mode: 'hold_advice',
          status: 'queued',
        },
      },
    },
  }
  const incoming = {
    holding: [],
    plan: [{ code: '000636', name: '风华高科' }],
    closed: [{
      id: 'sell-fenghua',
      code: '000636',
      type: 'SELL',
      qty: 1,
      holdingId: 'hold-fenghua',
    }],
  }

  const result = applyClientAccountSave(
    account,
    incoming,
    8,
    { forceTradeState: true },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(account.data.holding, [])
  assert.equal(account.data.closed[0].id, 'sell-fenghua')
  assert.equal(account.data.jobs['000636'].status, 'canceled')
  assert.equal(
    account.data.jobs['000636'].phase,
    '持仓已清仓，旧持仓复核已取消',
  )
})

test('客户端旧设置不能覆盖服务端较新的日报计划和自动运行状态', () => {
  const account = {
    nick: '测试账号',
    clientRevision: 4,
    data: {
      holding: [],
      plan: [],
      closed: [],
      settings: {
        'dailyReport.schedule': {
          enabled: true,
          morning: { enabled: true, time: '08:10' },
          noon: { enabled: true, time: '11:40' },
          evening: { enabled: true, time: '15:20' },
          updatedAt: 300,
        },
      },
      dailyReportAuto: {
        latest: { status: 'done', runKey: '2026-08-24:morning' },
        updatedAt: 400,
      },
    },
  }
  const result = applyClientAccountSave(account, {
    holding: [],
    plan: [],
    closed: [],
    settings: {
      'dailyReport.schedule': {
        enabled: false,
        morning: { enabled: true, time: '09:00' },
        noon: { enabled: false, time: '11:50' },
        evening: { enabled: false, time: '15:30' },
        updatedAt: 200,
      },
    },
  }, 4)

  assert.equal(result.ok, true)
  assert.equal(
    account.data.settings['dailyReport.schedule'].morning.time,
    '08:10',
  )
  assert.equal(account.data.dailyReportAuto.latest.status, 'done')
})
