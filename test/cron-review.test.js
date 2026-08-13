import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReviewPayload,
  processReviewAccount,
  reviewRecordFromAIResponse,
  reviewResponse,
} from '../api/cron_review.js'

function accountFixture() {
  return {
    nick: '复盘测试账号',
    clientRevision: 4,
    data: {
      holding: [{
        id: 'h1',
        code: '600001',
        name: '主板一号',
        qty: 2,
        buyPrice: 10,
        buyFee: 5,
        tFlows: [],
      }],
      closed: [{
        id: 'buy-today',
        type: 'BUY',
        code: '600001',
        price: 10,
        qty: 2,
        at: Date.UTC(2026, 7, 13, 2),
      }],
      account: { cash: 8000, initialCapital: 10000 },
      reviews: {},
      decisionLog: [],
      settings: { quantModelVersion: 'default' },
    },
  }
}

test('服务端复盘载荷使用实时持仓、行情、账户和当日成交', () => {
  const acc = accountFixture()
  const payload = buildReviewPayload(
    acc.data,
    '600001',
    '主板一号',
    { '600001': { price: 11 } },
    {
      now: Date.UTC(2026, 7, 13, 4),
      session: 'noon',
      nextTradeDay: '2026-08-14(周五)',
    },
  )

  assert.equal(payload.holdCost, 10)
  assert.equal(payload.holdQty, 2)
  assert.equal(payload.hold.pnlPct, 10)
  assert.equal(payload.account.totalAssets, 10200)
  assert.equal(payload.todayTrades.length, 1)
  assert.equal(payload.todayTrades[0].side, 'buy')
  assert.equal(payload.quantModelVersion, 'default')
})

test('FC自动复盘先保存租约再写入成功结果且同场不重复生成', async () => {
  let current = structuredClone(accountFixture())
  const writes = []
  const dependencies = {
    readLatest: async () => structuredClone(current),
    write: async (account, options) => {
      current = structuredClone(account)
      writes.push({ account: structuredClone(account), options })
      return account
    },
    fetchQuotes: async () => ({ '600001': { price: 11 } }),
    generate: async (payload) => {
      assert.equal(payload.accountRevision, 4)
      return {
        code: payload.code,
        name: payload.name,
        at: 1200,
        result: { stance: '持有', headline: '守住10.5继续持有' },
        meta: {
          evidenceSnapshot: {
            snapshotId: 'ev_review_test',
            schemaVersion: 'canonical-evidence.v1',
          },
        },
      }
    },
  }

  const first = await processReviewAccount(current, {
    session: 'noon',
    dayKey: '2026-08-13',
    now: 1000,
  }, dependencies)
  const second = await processReviewAccount(current, {
    session: 'noon',
    dayKey: '2026-08-13',
    now: 2000,
  }, dependencies)

  assert.equal(first.ok, 1)
  assert.equal(second.claimed, 0)
  assert.equal(writes.length, 2)
  assert.equal(writes[0].account.data.reviewAuto.runs['2026-08-13:noon'].codes['600001'].status, 'running')
  assert.equal(current.data.reviews['600001'].session, 'noon')
  assert.equal(
    current.data.reviews['600001'].meta.evidenceSnapshot.snapshotId,
    'ev_review_test',
  )
  assert.equal(current.data.reviewAuto.runs['2026-08-13:noon'].codes['600001'].status, 'done')
})

test('模型失败时记录失败并允许下一次Timer重试', async () => {
  let current = structuredClone(accountFixture())
  const dependencies = {
    readLatest: async () => structuredClone(current),
    write: async (account) => {
      current = structuredClone(account)
      return account
    },
    fetchQuotes: async () => ({ '600001': { price: 9.8 } }),
    generate: async () => {
      throw new Error('模型超时')
    },
  }

  const first = await processReviewAccount(current, {
    session: 'close',
    dayKey: '2026-08-13',
    now: 1000,
  }, dependencies)
  const retry = await processReviewAccount(current, {
    session: 'close',
    dayKey: '2026-08-13',
    now: 2000,
  }, dependencies)

  assert.equal(first.fail, 1)
  assert.equal(retry.fail, 1)
  assert.equal(current.data.reviewAuto.runs['2026-08-13:close'].codes['600001'].attempts, 2)
  assert.equal(current.data.reviews['600001'], undefined)
})

test('定时端点响应的成功布尔值不能被生成数量覆盖', () => {
  assert.deepEqual(reviewResponse('noon', {
    accounts: 1,
    claimed: 2,
    ok: 0,
    fail: 2,
  }), {
    ok: true,
    session: 'noon',
    accounts: 1,
    claimed: 2,
    generated: 0,
    failed: 2,
  })
})

test('自动复盘记录保留军师响应中的完整证据快照', () => {
  const record = reviewRecordFromAIResponse(
    { code: '600001', name: '主板一号' },
    {
      result: { stance: '持有' },
      meta: {
        evidenceSnapshot: {
          snapshotId: 'ev_review_test',
          schemaVersion: 'canonical-evidence.v1',
        },
      },
    },
    1200,
  )

  assert.equal(record.at, 1200)
  assert.equal(record.result.stance, '持有')
  assert.equal(record.meta.evidenceSnapshot.snapshotId, 'ev_review_test')
})
