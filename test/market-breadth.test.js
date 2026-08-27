import test from 'node:test'
import assert from 'node:assert/strict'

import {
  summarizeMarketBreadth,
  summarizeMarketSentiment,
} from '../api/market.js'

test('市场广度使用沪深北指数真实涨跌家数且不重复计算创业板', () => {
  const result = summarizeMarketBreadth([
    { f12: '000001', f104: 529, f105: 1777, f106: 45 },
    { f12: '399001', f104: 571, f105: 2314, f106: 47 },
    { f12: '399006', f104: 296, f105: 1089, f106: 16 },
    { f12: '899050', f104: 58, f105: 276, f106: 1 },
  ], {
    limitUp: 59,
    limitDown: 4,
  })

  assert.deepEqual(result, {
    up: 1158,
    down: 4367,
    flat: 93,
    limitUp: 59,
    limitDown: 4,
    total: 5618,
    complete: true,
  })
})

test('真实涨跌家数缺失时不拿排行榜前100伪装全市场广度', () => {
  const result = summarizeMarketBreadth(
    [{ f12: '000001' }],
    { limitUp: 59, limitDown: 4 },
  )

  assert.equal(result.complete, false)
  assert.equal(result.up, null)
  assert.equal(result.down, null)
  assert.equal(result.total, null)
})

test('市场情绪使用权威池总数计算炸板率和连板高度', () => {
  const result = summarizeMarketSentiment({
    limitUpPool: {
      total: 30,
      list: [
        { lbc: 1 },
        { lbc: 3 },
        { lbc: 5 },
      ],
    },
    limitDownPool: { total: 4, list: [] },
    brokenLimitPool: { total: 10, list: [] },
  })

  assert.equal(result.breakRatePct, 25)
  assert.equal(result.maxBoardHeight, 5)
  assert.equal(result.linkedBoardCount, 2)
  assert.equal(result.phase, 'EXPANSION')
  assert.deepEqual(result.hardRiskSignals, [])
  assert.equal(result.dataQuality, 'COMPLETE')
})

test('炸板率超过40%时明确进入退潮红线', () => {
  const result = summarizeMarketSentiment({
    limitUpPool: { total: 20, list: [{ lbc: 2 }] },
    limitDownPool: { total: 8, list: [] },
    brokenLimitPool: { total: 15, list: [] },
  })

  assert.equal(result.breakRatePct, 42.9)
  assert.equal(result.phase, 'RETREAT')
  assert.match(result.hardRiskSignals.join('；'), /炸板率/)
})

test('涨跌停池缺失时不把未知情绪误判为退潮', () => {
  const result = summarizeMarketSentiment()

  assert.equal(result.phase, 'UNKNOWN')
  assert.equal(result.breakRatePct, null)
  assert.deepEqual(result.hardRiskSignals, [])
  assert.equal(result.dataQuality, 'MISSING')
})
