import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchQuotes, mapEastmoneyQuote } from '../api/quote.js'

const preOpen = Date.parse('2026-08-27T01:03:00.000Z')

test('东财竞价前返回0时补取腾讯并展示最近有效收盘价', async () => {
  const requested = []
  const list = await fetchQuotes(['000737'], {
    now: preOpen,
    fetchEastmoney: async () => [{
      code: '000737',
      name: '北方铜业',
      source: '东方财富',
      price: 0,
      pct: 0,
      chg: 0,
      prevClose: 15.44,
      tradeDate: '2026-08-27',
      industry: '工业金属',
    }],
    fetchTencent: async (codes) => {
      requested.push(...codes)
      return [{
        code: '000737',
        name: '',
        source: '腾讯财经',
        price: 15.44,
        pct: 6.26,
        chg: 0.91,
        prevClose: 14.53,
        tradeDate: '2026-08-26',
      }]
    },
  })

  assert.deepEqual(requested, ['000737'])
  assert.equal(list.length, 1)
  assert.equal(list[0].price, 15.44)
  assert.equal(list[0].pct, 0)
  assert.equal(list[0].chg, 0)
  assert.equal(list[0].name, '北方铜业')
  assert.equal(list[0].industry, '工业金属')
  assert.equal(list[0].tradeDate, '2026-08-26')
  assert.equal(list[0].priceStatus, 'PREVIOUS_CLOSE')
  assert.equal(list[0].priceLabel, '昨收')
  assert.equal(list[0].isLivePrice, false)
})

test('东财竞价价为0时使用腾讯当日竞价价并标记为不可执行', async () => {
  const auction = Date.parse('2026-08-27T01:20:00.000Z')
  const list = await fetchQuotes(['000737'], {
    now: auction,
    fetchEastmoney: async () => [{
      code: '000737',
      name: '北方铜业',
      source: '东方财富',
      price: 0,
      prevClose: 15.44,
      tradeDate: '2026-08-27',
      industry: '工业金属',
    }],
    fetchTencent: async () => [{
      code: '000737',
      name: '',
      source: '腾讯财经',
      price: 15.6,
      pct: 1.04,
      chg: 0.16,
      prevClose: 15.44,
      tradeDate: '2026-08-27',
    }],
  })

  assert.equal(list[0].price, 15.6)
  assert.equal(list[0].pct, 1.04)
  assert.equal(list[0].name, '北方铜业')
  assert.equal(list[0].industry, '工业金属')
  assert.equal(list[0].priceStatus, 'AUCTION')
  assert.equal(list[0].priceLabel, '竞价')
  assert.equal(list[0].isLivePrice, false)
})

test('连续竞价有效价保持可执行且不调用备用源', async () => {
  const morning = Date.parse('2026-08-27T02:00:00.000Z')
  let tencentCalls = 0
  const list = await fetchQuotes(['000737'], {
    now: morning,
    fetchEastmoney: async () => [{
      code: '000737',
      name: '北方铜业',
      source: '东方财富',
      price: 15.6,
      pct: 1.04,
      chg: 0.16,
      prevClose: 15.44,
      tradeDate: '2026-08-27',
      industry: '工业金属',
    }],
    fetchTencent: async () => {
      tencentCalls += 1
      return []
    },
  })

  assert.equal(tencentCalls, 0)
  assert.equal(list[0].price, 15.6)
  assert.equal(list[0].priceStatus, 'LIVE')
  assert.equal(list[0].priceLabel, '')
  assert.equal(list[0].isLivePrice, true)
})

test('两个行情源都没有现价时使用东财昨收且不伪造行情日期', async () => {
  const list = await fetchQuotes(['000737'], {
    now: preOpen,
    fetchEastmoney: async () => [{
      code: '000737',
      name: '北方铜业',
      source: '东方财富',
      price: 0,
      prevClose: 15.44,
      tradeDate: '2026-08-27',
      industry: '工业金属',
    }],
    fetchTencent: async () => [],
  })

  assert.equal(list[0].price, 15.44)
  assert.equal(list[0].tradeDate, null)
  assert.equal(list[0].priceStatus, 'PREVIOUS_CLOSE')
  assert.equal(list[0].priceLabel, '昨收')
  assert.equal(list[0].isLivePrice, false)
})

test('休市时保留最近收盘日的活跃度与资金快照', async () => {
  const weekend = Date.parse('2026-08-29T02:00:00.000Z')
  const list = await fetchQuotes(['300390'], {
    now: weekend,
    fetchEastmoney: async () => [{
      code: '300390',
      name: '天华新能',
      source: '东方财富',
      price: 64.12,
      pct: 1.46,
      chg: 0.92,
      turnover: 5.38,
      volRatio: 0.78,
      mainInflow: 181_197_588,
      retailInflow: -211_449_936,
      main5dInflow: 286_921_224,
      retail5dInflow: -416_996_256,
      mainRatio: 7.42,
      amount: 2_442_216_361.28,
      high: 64.98,
      low: 62.36,
      open: 63.98,
      prevClose: 63.2,
      tradeDate: '2026-08-28',
      industry: '电池',
    }],
    fetchTencent: async () => [],
  })

  assert.equal(list[0].priceStatus, 'PREVIOUS_CLOSE')
  assert.equal(list[0].priceLabel, '最近收盘')
  assert.equal(list[0].isLivePrice, false)
  assert.equal(list[0].tradeDate, '2026-08-28')
  assert.equal(list[0].pct, 1.46)
  assert.equal(list[0].turnover, 5.38)
  assert.equal(list[0].volRatio, 0.78)
  assert.equal(list[0].mainInflow, 181_197_588)
  assert.equal(list[0].retailInflow, -211_449_936)
  assert.equal(list[0].main5dInflow, 286_921_224)
  assert.equal(list[0].retail5dInflow, -416_996_256)
})

test('休市扶摇快照误标当天时用腾讯校正收盘日并补齐活跃度', async () => {
  const weekend = Date.parse('2026-09-12T00:35:00+08:00')
  const requested = []
  const list = await fetchQuotes(['002475'], {
    now: weekend,
    fetchFuyao: async () => [{
      code: '002475',
      source: '同花顺扶摇',
      price: 55.39,
      pct: 1.73,
      amount: 4_768_100_000,
      high: 55.92,
      low: 53.35,
      open: 53.84,
      prevClose: 54.45,
      tradeDate: '2026-09-12',
    }],
    fetchEastmoney: async () => [],
    fetchTencent: async (codes) => {
      requested.push(...codes)
      return [{
        code: '002475',
        source: '腾讯财经',
        price: 55.39,
        pct: 1.73,
        turnover: 1.19,
        volRatio: 1,
        amount: 4_768_100_000,
        high: 55.92,
        low: 53.35,
        open: 53.84,
        prevClose: 54.45,
        tradeDate: '2026-09-11',
      }]
    },
  })

  assert.deepEqual(requested, ['002475'])
  assert.equal(list[0].price, 55.39)
  assert.equal(list[0].tradeDate, '2026-09-11')
  assert.equal(list[0].turnover, 1.19)
  assert.equal(list[0].volRatio, 1)
  assert.equal(list[0].priceStatus, 'PREVIOUS_CLOSE')
  assert.equal(list[0].priceLabel, '最近收盘')
  assert.equal(list[0].isLivePrice, false)
})

test('东财报价映射保留五日主力与小单累计且缺失值不伪装成零', () => {
  const quote = mapEastmoneyQuote({
    f12: '300390',
    f14: '天华新能',
    f2: 64.12,
    f124: Date.parse('2026-08-28T07:00:00.000Z') / 1000,
    f164: 286_921_224,
    f172: -416_996_256,
  })
  const missing = mapEastmoneyQuote({
    f12: '300390',
    f14: '天华新能',
    f2: 64.12,
    f164: '-',
    f172: '',
  })

  assert.equal(quote.main5dInflow, 286_921_224)
  assert.equal(quote.retail5dInflow, -416_996_256)
  assert.equal(missing.main5dInflow, null)
  assert.equal(missing.retail5dInflow, null)
})

test('扶摇当前价优先且东财只补充换手行业与资金字段', async () => {
  const morning = Date.parse('2026-09-11T02:00:00.000Z')
  let tencentCalls = 0
  const list = await fetchQuotes(['600519'], {
    now: morning,
    fetchFuyao: async () => [{
      code: '600519',
      source: '同花顺扶摇',
      price: 1280,
      pct: 0.95,
      chg: 12,
      amount: 2_560_000_000,
      high: 1285,
      low: 1260,
      open: 1268,
      prevClose: 1268,
      tradeDate: '2026-09-11',
    }],
    fetchEastmoney: async () => [{
      code: '600519',
      name: '贵州茅台',
      source: '东方财富',
      price: 1279.5,
      pct: 0.9,
      turnover: 0.42,
      volRatio: 1.2,
      mainInflow: 100_000_000,
      retailInflow: -50_000_000,
      tradeDate: '2026-09-11',
      industry: '白酒',
    }],
    fetchTencent: async () => {
      tencentCalls += 1
      return []
    },
  })

  assert.equal(tencentCalls, 0)
  assert.equal(list[0].price, 1280)
  assert.equal(list[0].source, '同花顺扶摇')
  assert.equal(list[0].name, '贵州茅台')
  assert.equal(list[0].industry, '白酒')
  assert.equal(list[0].turnover, 0.42)
  assert.equal(list[0].mainInflow, 100_000_000)
  assert.equal(list[0].isLivePrice, true)
})
