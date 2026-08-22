import test from 'node:test'
import assert from 'node:assert/strict'

import handler, {
  strategySpecResponse,
} from '../api/strategy_specs.js'

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    send(value) {
      this.body = typeof value === 'string' ? value : JSON.stringify(value)
      return this
    },
    end(value = '') {
      this.body = typeof value === 'string' ? value : JSON.stringify(value)
      return this
    },
  }
}

test('策略目录返回五类v2策略并支持按ID读取', () => {
  const list = strategySpecResponse('')
  const one = strategySpecResponse('market-quant-resonance')

  assert.equal(list.status, 200)
  assert.equal(list.body.ok, true)
  assert.equal(list.body.schemaVersion, 'strategy-catalog.v2')
  assert.equal(list.body.data.length, 5)
  assert.deepEqual(
    new Set(list.body.data.map((item) => item.family)),
    new Set([
      'TREND_BREAKOUT',
      'CROSS_SECTIONAL_MOMENTUM',
      'RANGE_MEAN_REVERSION',
      'MULTI_FACTOR_RANKING',
      'DEFENSIVE_EXIT',
    ]),
  )
  assert.match(list.body.data[0].specVersion, /^strategy\./)
  assert.equal(one.body.strategy.strategyId, 'market-quant-resonance')
  assert.equal(one.body.strategy.schemaVersion, 'strategy-spec.v2')
  assert.equal(
    one.body.strategy.specVersion,
    list.body.data.find(
      (item) => item.strategyId === 'market-quant-resonance',
    ).specVersion,
  )
})

test('未知策略返回404', () => {
  const response = strategySpecResponse('unknown-strategy')

  assert.equal(response.status, 404)
  assert.equal(response.body.ok, false)
})

test('策略目录只允许GET并提供跨域缓存响应', async () => {
  const req = { method: 'POST', query: {}, headers: {} }
  const res = responseCapture()

  await handler(req, res)

  assert.equal(res.statusCode, 405)
  assert.equal(JSON.parse(res.body).ok, false)
})
