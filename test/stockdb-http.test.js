import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockDbUrl,
  createStockDbHttpClient,
} from '../scripts/lib/stockdb-http.mjs'

test('StockDB查询生成本地只读URL', () => {
  const url = buildStockDbUrl({
    command: 'vals',
    table: '日k',
    codePattern: '6*',
    dateQuery: '20260401<20260908',
    fields: ['date', 'code', 'close'],
  })

  assert.equal(url.origin, 'http://127.0.0.1:7899')
  assert.equal(url.searchParams.get('cmd'), 'vals')
  assert.equal(url.searchParams.get('t'), '日k')
  assert.equal(url.searchParams.get('k1'), 'qz:6')
  assert.equal(url.searchParams.get('k2'), 'fwd:20260401,20260908')
  assert.equal(url.searchParams.get('ap'), 'get.date,code,close')
})

test('StockDB分钟查询允许完整时间范围', () => {
  const url = buildStockDbUrl({
    command: 'vals',
    table: '分钟k',
    codePattern: '600519',
    dateQuery: '20260908093000<20260908150000',
  })

  assert.equal(
    url.searchParams.get('k2'),
    'fwd:20260908093000,20260908150000',
  )
})

test('StockDB拒绝外部地址、写命令和任意查询表达式', () => {
  assert.throws(
    () => buildStockDbUrl({
      baseUrl: 'https://example.com',
      command: 'get',
      table: '股票代码',
    }),
    /回环/,
  )
  assert.throws(
    () => buildStockDbUrl({
      command: 'set',
      table: '日k',
    }),
    /命令/,
  )
  assert.throws(
    () => buildStockDbUrl({
      command: 'vals',
      table: '日k',
      codePattern: '6*',
      dateQuery: '../../secret',
    }),
    /日期/,
  )
})

test('StockDB客户端解析JSON并限制响应大小', async () => {
  const requests = []
  const client = createStockDbHttpClient({
    maximumBytes: 64,
    fetchImpl: async (url) => {
      requests.push(String(url))
      return new Response(JSON.stringify([{ code: '600519' }]), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(
    await client.values('日k', '6*', '20260908'),
    [{ code: '600519' }],
  )
  assert.equal(requests.length, 1)

  const oversized = createStockDbHttpClient({
    maximumBytes: 8,
    fetchImpl: async () => new Response('{"value":"too large"}'),
  })
  await assert.rejects(
    () => oversized.getStockCodes(),
    /大小上限/,
  )
})
