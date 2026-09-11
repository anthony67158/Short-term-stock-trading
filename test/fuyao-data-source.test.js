import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchFuyaoDailyKline,
  fetchFuyaoQuotes,
  fuyaoConfigured,
  mapFuyaoQuote,
  toFuyaoThscode,
} from '../api/_fuyao.js'

const env = { FUYAO_API_KEY: 'test-key' }

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

test('扶摇代码转换覆盖沪深北且拒绝非法代码', () => {
  assert.equal(toFuyaoThscode('600519'), '600519.SH')
  assert.equal(toFuyaoThscode('000001'), '000001.SZ')
  assert.equal(toFuyaoThscode('920001'), '920001.BJ')
  assert.equal(toFuyaoThscode('430001'), '430001.BJ')
  assert.equal(toFuyaoThscode('invalid'), null)
})

test('未配置Key时不请求外部数据源', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return response({})
  }
  assert.equal(fuyaoConfigured({}), false)
  assert.deepEqual(
    await fetchFuyaoQuotes(['600519'], {
      env: {},
      fetchImpl,
    }),
    [],
  )
  assert.equal(calls, 0)
})

test('扶摇快照按统一行情字段映射且不混淆成交额与换手率', async () => {
  let request
  const list = await fetchFuyaoQuotes(['600519', '000001'], {
    env,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options }
      return response({
        code: 0,
        message: 'success',
        request_id: 'request-test',
        data: {
          timestamp: Date.parse('2026-09-11T02:30:00Z'),
          item: [{
            thscode: '600519.SH',
            ticker: '600519',
            last_price: 1280,
            price_change: 12,
            price_change_ratio_pct: 0.95,
            open_price: 1268,
            high_price: 1285,
            low_price: 1260,
            prev_price: 1268,
            volume: 2_000_000,
            turnover: 2_560_000_000,
          }],
        },
      })
    },
  })

  assert.match(
    request.url,
    /thscodes=600519\.SH%2C000001\.SZ/,
  )
  assert.equal(request.options.headers['X-api-key'], 'test-key')
  assert.equal(list[0].source, '同花顺扶摇')
  assert.equal(list[0].tradeDate, '2026-09-11')
  assert.equal(list[0].price, 1280)
  assert.equal(list[0].amount, 2_560_000_000)
  assert.equal(list[0].turnover, null)
  assert.equal(list[0].vwap, 1280)
})

test('扶摇日线只接受日频并转换为现有K线合同', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(new URL(url))
    return response({
      code: 0,
      message: 'success',
      request_id: 'request-kline',
      data: {
        timestamp: Date.parse('2026-09-11T07:00:00Z'),
        item: [
          {
            date_ms: Date.parse('2026-09-10T16:00:00Z'),
            open_price: 10,
            high_price: 11,
            low_price: 9.8,
            close_price: 10.5,
            volume: 1000,
            turnover: 10300,
          },
          {
            date_ms: Date.parse('2026-09-11T16:00:00Z'),
            open_price: 10.5,
            high_price: 11.2,
            low_price: 10.3,
            close_price: 11,
            volume: 1200,
            turnover: 13000,
          },
        ],
      },
    })
  }
  const result = await fetchFuyaoDailyKline(
    '600519',
    '101',
    120,
    {
      env,
      fetchImpl,
      now: Date.parse('2026-09-12T00:00:00Z'),
    },
  )

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].searchParams.get('thscode'),
    '600519.SH',
  )
  assert.equal(calls[0].searchParams.get('adjust'), 'forward')
  assert.equal(result.source, '同花顺扶摇')
  assert.deepEqual(
    result.candles.map((item) => item.date),
    ['2026-09-11', '2026-09-12'],
  )
  assert.equal(result.candles[1].pct, 4.76)
  assert.equal(
    await fetchFuyaoDailyKline('600519', '102', 120, {
      env,
      fetchImpl,
    }),
    null,
  )
})

test('扶摇业务错误和非法响应必须失败关闭', async () => {
  await assert.rejects(
    fetchFuyaoQuotes(['600519'], {
      env,
      fetchImpl: async () => response({
        code: 2003,
        message: 'forbidden',
        data: null,
      }),
    }),
    /业务错误 2003/,
  )
  await assert.rejects(
    fetchFuyaoQuotes(['600519'], {
      env,
      fetchImpl: async () => response({
        code: 0,
        data: {},
      }),
    }),
    /响应结构无效/,
  )
})

test('扶摇快照映射拒绝无效数值且保留标准代码', () => {
  const quote = mapFuyaoQuote({
    thscode: '000001.SZ',
    ticker: '000001',
    last_price: '-',
    turnover: 0,
  }, null)
  assert.equal(quote.code, '000001')
  assert.equal(quote.thscode, '000001.SZ')
  assert.equal(quote.price, null)
  assert.equal(quote.amount, null)
  assert.equal(quote.tradeDate, null)
})
