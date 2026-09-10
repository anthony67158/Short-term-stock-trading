import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectMarketSnapshot,
  readMarketSnapshot,
  resetMarketSnapshotCache,
} from '../api/market_snapshot.js'

test('聚合行情复用同一批涨跌停数据并返回国内外七类快照', async () => {
  resetMarketSnapshotCache()
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
      breadth: {
        amountYi: 1_000,
        volVsAvg5: 25,
        volumeComparable: true,
      },
      zt: await options.limitUpPool,
      dt: await options.limitDownPool,
      zb: await options.brokenLimitPool,
    }),
    sectors: async () => ({
      ok: true,
      list: [
        { code: 'BK001', mainInflow: 300_000_000 },
        { code: 'BK002', mainInflow: -100_000_000 },
      ],
    }),
    movers: async (kind) => ({ ok: true, kind, list: [] }),
    overseas: async () => ({
      indices: [{ label: '纳斯达克', price: 18000, pct: 0.8 }],
      commodities: [{ label: '美原油(WTI)', price: 70, pct: -0.3 }],
    }),
    now: () => 123,
  })

  assert.deepEqual(poolCalls.sort(), ['dt', 'zb', 'zt'])
  assert.equal(result.market.zt, pools.zt)
  assert.equal(result.limitUp, pools.zt)
  assert.equal(result.brokenLimit, pools.zb)
  assert.equal(result.sectors.list[0].code, 'BK001')
  assert.equal(result.movers.kind, 'inflow')
  assert.equal(result.speed.kind, 'speed')
  assert.equal(result.overseas.indices[0].label, '纳斯达克')
  assert.equal(result.overseas.commodities[0].label, '美原油(WTI)')
  assert.equal(result.marketFunds.mainNetYi, 2)
  assert.equal(result.marketFunds.direction, 'INFLOW')
  assert.equal(result.marketFunds.turnover.deltaYi, 200)
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
    overseas: async () => ({ indices: [], commodities: [] }),
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

test('海外行情失败只降级海外区域', async () => {
  resetMarketSnapshotCache()
  const result = await collectMarketSnapshot({
    market: async () => ({
      ok: true,
      indices: [{ code: '000001', name: '上证指数' }],
    }),
    sectors: async () => ({ ok: true, list: [] }),
    limitPool: async (kind) => ({ kind, list: [] }),
    movers: async (kind) => ({ ok: true, kind, list: [] }),
    overseas: async () => {
      throw new Error('overseas unavailable')
    },
    now: () => 2_000,
  })

  assert.equal(result.ok, true)
  assert.equal(result.market.indices[0].name, '上证指数')
  assert.equal(result.overseas, null)
  assert.match(result.errors.overseas, /overseas unavailable/)
})
