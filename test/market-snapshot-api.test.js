import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectMarketSnapshot,
  readMarketSnapshot,
  resetMarketSnapshotCache,
} from '../api/market_snapshot.js'

test('聚合行情复用同一批涨跌停数据并返回六类快照', async () => {
  const poolCalls = []
  const pools = {
    zt: { kind: 'zt', list: [{ code: '600001' }] },
    dt: { kind: 'dt', list: [] },
    zb: { kind: 'zb', list: [{ code: '600002' }] },
  }
  const result = await collectMarketSnapshot({
    limitPool: async (kind) => {
      poolCalls.push(kind)
      return pools[kind]
    },
    market: async (options) => ({
      ok: true,
      zt: await options.limitUpPool,
      dt: await options.limitDownPool,
      zb: await options.brokenLimitPool,
    }),
    sectors: async () => ({ ok: true, list: [{ code: 'BK001' }] }),
    movers: async (kind) => ({ ok: true, kind, list: [] }),
    now: () => 123,
  })

  assert.deepEqual(poolCalls.sort(), ['dt', 'zb', 'zt'])
  assert.equal(result.market.zt, pools.zt)
  assert.equal(result.limitUp, pools.zt)
  assert.equal(result.brokenLimit, pools.zb)
  assert.equal(result.sectors.list[0].code, 'BK001')
  assert.equal(result.movers.kind, 'inflow')
  assert.equal(result.speed.kind, 'speed')
  assert.deepEqual(result.errors, {})
})

test('聚合行情允许单个数据源失败并缓存并发请求', async () => {
  resetMarketSnapshotCache()
  let marketCalls = 0
  const options = {
    market: async () => {
      marketCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { ok: true }
    },
    sectors: async () => {
      throw new Error('sector unavailable')
    },
    limitPool: async (kind) => ({ kind, list: [] }),
    movers: async (kind) => ({ ok: true, kind, list: [] }),
    now: () => 1_000,
  }

  const [left, right] = await Promise.all([
    readMarketSnapshot(options),
    readMarketSnapshot(options),
  ])

  assert.equal(marketCalls, 1)
  assert.equal(left, right)
  assert.equal(left.ok, true)
  assert.equal(left.sectors, null)
  assert.match(left.errors.sectors, /sector unavailable/)
})
