import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockFundSnapshot,
  fetchStockFund,
  parseStockFundHistory,
} from '../api/_stock_fund.js'
import {
  compareStockFundSnapshots,
} from '../shared/retailFundFlow.js'

const historyLines = [
  '2026-08-21,100000000,-60000000,0,40000000,60000000,3.1',
  '2026-08-24,120000000,-70000000,0,50000000,70000000,3.5',
  '2026-08-25,150000000,-80000000,0,60000000,90000000,4.1',
  '2026-08-26,180000000,-90000000,0,70000000,110000000,4.8',
  '2026-08-27,200000000,-100000000,0,80000000,120000000,5.2',
]

test('资金历史同时保留近5日主力与散户代理序列', () => {
  const rows = parseStockFundHistory(historyLines)
  const snapshot = buildStockFundSnapshot({
    historyRows: rows,
    fetchedAt: Date.parse('2026-08-28T02:00:00.000Z'),
  })

  assert.deepEqual(snapshot.mainTrend5, [1, 1.2, 1.5, 1.8, 2])
  assert.deepEqual(snapshot.retailTrend5, [-0.6, -0.7, -0.8, -0.9, -1])
  assert.equal(snapshot.main5dYi, 7.5)
  assert.equal(snapshot.retail5dYi, -4)
  assert.equal(snapshot.mainStreak, 5)
  assert.equal(snapshot.retailStreak, -5)
})

test('盘中快照覆盖当日主力与散户值但保留历史序列', () => {
  const snapshot = buildStockFundSnapshot({
    historyRows: parseStockFundHistory(historyLines),
    realtime: {
      mainNetYi: -0.4,
      retailNetYi: 0.7,
      mainNetPct: -1.8,
    },
    preferRealtime: true,
    fetchedAt: Date.parse('2026-08-28T02:00:00.000Z'),
  })

  assert.equal(snapshot.source, 'realtime')
  assert.equal(snapshot.isHistorical, false)
  assert.equal(snapshot.mainNetYi, -0.4)
  assert.equal(snapshot.retailNetYi, 0.7)
  assert.deepEqual(snapshot.mainTrend5, [1, 1.2, 1.5, 1.8, 2])
  assert.equal(snapshot.retailFlow.relation, 'main_out_retail_in')
})

test('快速采集并行请求历史与实时资金且不信任外部输入', async () => {
  const urls = []
  const snapshot = await fetchStockFund('600000', {
    preferRealtime: true,
    fetchedAt: Date.parse('2026-08-28T02:00:00.000Z'),
    fetchImpl: async (url) => {
      urls.push(url)
      return {
        ok: true,
        async json() {
          return url.includes('/fflow/daykline/get')
            ? { data: { klines: historyLines } }
            : {
                data: {
                  f62: 230000000,
                  f84: -140000000,
                  f184: 5.8,
                },
              }
        },
      }
    },
  })

  assert.ok(urls.some((url) => url.includes('/fflow/daykline/get')))
  assert.ok(urls.some((url) => url.includes('/api/qt/stock/get')))
  assert.equal(snapshot.mainNetYi, 2.3)
  assert.equal(snapshot.retailNetYi, -1.4)
  assert.equal(snapshot.history5.length, 5)
})

test('资金历史镜像优先选择完整五日而不是最快的一日结果', async () => {
  const oneDay = historyLines.slice(-1)
  const snapshot = await fetchStockFund('600487', {
    preferRealtime: true,
    fetchedAt: Date.parse('2026-08-28T02:00:00.000Z'),
    fetchImpl: async (url) => {
      if (url.includes('/fflow/daykline/get')) {
        const complete = url.includes('push2his.eastmoney.com')
          || url.includes('82.push2his.eastmoney.com')
        if (complete) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return {
          ok: true,
          async json() {
            return {
              data: {
                klines: complete ? historyLines : oneDay,
              },
            }
          },
        }
      }
      return {
        ok: true,
        async json() {
          return {
            data: {
              f62: -1_403_000_000,
              f84: 1_259_000_000,
            },
          }
        },
      }
    },
  })

  assert.equal(snapshot.historyDayCount, 5)
  assert.equal(snapshot.historyComplete, true)
  assert.equal(snapshot.history5.length, 5)
  assert.deepEqual(snapshot.mainTrend5, [1, 1.2, 1.5, 1.8, 2])
  assert.deepEqual(
    snapshot.retailTrend5,
    [-0.6, -0.7, -0.8, -0.9, -1],
  )
})

test('资金快照比较识别主力由流入转流出与散户反向承接', () => {
  const change = compareStockFundSnapshots({
    mainNetYi: -0.4,
    retailNetYi: 0.7,
  }, {
    mainNetYi: 1.2,
    retailNetYi: -0.5,
  })

  assert.equal(change.status, 'COMPARED')
  assert.equal(change.mainDeltaYi, -1.6)
  assert.equal(change.retailDeltaYi, 1.2)
  assert.equal(change.relationChanged, true)
  assert.match(change.summary, /主力由流入转流出/)
  assert.match(change.summary, /散户代理由流出转流入/)
})
