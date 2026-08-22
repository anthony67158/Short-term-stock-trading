import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAdviceWorkerEvent,
  buildDailyReportWorkerEvent,
  dispatchAdviceWorker,
  dispatchDailyReportWorker,
} from '../api/_advice_dispatch.js'
import {
  shouldContinueAdviceWorker,
} from '../api/_jobs.js'

test('建议Worker使用FC异步调用并携带最小账号事件', async () => {
  const calls = []
  const result = await dispatchAdviceWorker('飞飞徐', {
    env: {
      CRON_KEY: 'secret-key',
      ADVICE_FC_REGION: 'cn-hangzhou',
      ADVICE_FC_FUNCTION_NAME: 'stock-dashboard',
    },
    invoke: async (request) => {
      calls.push(request)
      return { requestId: 'req-1' }
    },
  })

  assert.deepEqual(buildAdviceWorkerEvent('飞飞徐', 'secret-key'), {
    source: 'stock-dashboard.advice-worker',
    key: 'secret-key',
    nick: '飞飞徐',
  })
  assert.deepEqual(calls, [{
    functionName: 'stock-dashboard',
    region: 'cn-hangzhou',
    qualifier: 'LATEST',
    invocationType: 'Async',
    event: {
      source: 'stock-dashboard.advice-worker',
      key: 'secret-key',
      nick: '飞飞徐',
    },
  }])
  assert.deepEqual(result, { accepted: true, requestId: 'req-1' })
})

test('建议Worker缺少内部密钥时拒绝伪异步调度', async () => {
  await assert.rejects(
    () => dispatchAdviceWorker('飞飞徐', {
      env: {},
      invoke: async () => ({ requestId: 'should-not-run' }),
    }),
    /内部调度密钥未配置/,
  )
})

test('日报Worker使用独立事件且携带场次幂等键', async () => {
  const calls = []
  const options = {
    env: {
      CRON_KEY: 'secret-key',
      ADVICE_FC_REGION: 'cn-hangzhou',
      ADVICE_FC_FUNCTION_NAME: 'stock-dashboard',
    },
    invoke: async (request) => {
      calls.push(request)
      return { requestId: 'daily-request' }
    },
  }
  const event = buildDailyReportWorkerEvent({
    nick: '测试账号',
    session: 'evening',
    runKey: '2026-08-24:evening',
  }, 'secret-key')

  assert.deepEqual(event, {
    source: 'stock-dashboard.daily-report-worker',
    key: 'secret-key',
    nick: '测试账号',
    session: 'evening',
    runKey: '2026-08-24:evening',
  })
  assert.deepEqual(
    await dispatchDailyReportWorker({
      nick: '测试账号',
      session: 'evening',
      runKey: '2026-08-24:evening',
    }, options),
    { accepted: true, requestId: 'daily-request' },
  )
  assert.equal(calls.length, 1)
})

test('本轮达到启动预算但仍有排队任务时立即接力Worker', () => {
  assert.equal(shouldContinueAdviceWorker({
    jobs: {
      a: { status: 'done' },
      b: { status: 'queued' },
    },
  }), true)
  assert.equal(shouldContinueAdviceWorker({
    jobs: {
      a: { status: 'done' },
      b: { status: 'failed' },
    },
  }), false)
})
