import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeMarketBreadth } from '../api/market.js'

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
