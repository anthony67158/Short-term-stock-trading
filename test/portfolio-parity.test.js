import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computePortfolio as computeServerPortfolio,
  computeTFlows as computeServerTFlows,
  livePositionOf as liveServerPosition,
  t1StatusOf as serverT1Status,
} from '../api/_portfolio.js'
import {
  computePortfolio as computeBrowserPortfolio,
  computeTFlows as computeBrowserTFlows,
  livePositionOf as liveBrowserPosition,
  planStore,
  t1StatusOf as browserT1Status,
} from '../src/planStore.js'

const now = Date.now()
const holding = [{
  id: 'h1',
  code: '600001',
  name: '统一口径',
  qty: 3,
  buyPrice: 10,
  buyFee: 5,
  tFlows: [
    { id: 's1', side: 'sell', price: 11, qty: 2, fee: 6, cashApplied: true, at: now - 3000 },
    { id: 'b1', side: 'buy', price: 9, qty: 1, fee: 5, cashApplied: true, at: now - 2000 },
    { id: 'b2', side: 'buy', price: 9.5, qty: 2, fee: 5, cashApplied: false, at: now - 1000 },
  ],
}]

test('浏览器与服务端返回完全一致的FIFO做T配对结果', () => {
  const browser = computeBrowserTFlows(holding[0].tFlows)
  const server = computeServerTFlows(holding[0].tFlows)

  assert.deepEqual(server, browser)
  assert.equal(server.pairs, 2)
  assert.equal(server.pairList.length, 2)
  assert.equal(server.openBuy, 1)
  assert.equal(server.openBuyCashApplied, false)
})

test('浏览器与服务端使用同一实时持仓和T+1明细口径', () => {
  const closed = [{
    id: 'buy-today',
    type: 'BUY',
    code: '600001',
    price: 10.2,
    qty: 1,
    at: now - 4000,
  }]
  planStore.setData({
    plan: [],
    holding,
    closed,
  })

  assert.deepEqual(liveServerPosition(holding, '600001'), liveBrowserPosition('600001'))
  assert.deepEqual(serverT1Status(holding, closed, '600001'), browserT1Status('600001'))
  assert.equal(serverT1Status(holding, closed, '600001').buys.every((item) => item.at), true)
})

test('浏览器与服务端对异常数值采用相同有限数降级', () => {
  const dirtyHolding = [{
    id: 'dirty',
    code: '600002',
    name: '脏数据',
    qty: 'invalid',
    buyPrice: undefined,
    buyFee: Number.NaN,
    tFlows: [],
  }]
  const quoteMap = {
    '600002': { price: Number.NaN, prevClose: Number.NaN },
  }
  const account = { cash: 10000, initialCapital: 10000 }
  const browser = computeBrowserPortfolio(dirtyHolding, quoteMap, account)
  const server = computeServerPortfolio(dirtyHolding, quoteMap, account)

  assert.deepEqual(server, browser)
  assert.equal(Number.isFinite(server.holdMktValue), true)
  assert.equal(Number.isFinite(server.positions[0].floatPnl), true)
})
