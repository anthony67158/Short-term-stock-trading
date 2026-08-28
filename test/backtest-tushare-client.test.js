import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mergeAdjFactor,
  normalizeDaily,
  resolveTushareToken,
  tableToRows,
} from '../backtest/data/tushareClient.js'
import { toTsCode, barsForBacktest } from '../backtest/data/dataStore.js'

test('tableToRows 把 Tushare fields/items 表格转为对象数组', () => {
  const rows = tableToRows({
    fields: ['trade_date', 'open', 'close'],
    items: [
      ['20260803', 10.1, 10.5],
      ['20260804', 10.5, 10.8],
    ],
  })
  assert.deepEqual(rows, [
    { trade_date: '20260803', open: 10.1, close: 10.5 },
    { trade_date: '20260804', open: 10.5, close: 10.8 },
  ])
})

test('normalizeDaily 规整并按日期升序，过滤缺失价', () => {
  const bars = normalizeDaily([
    { trade_date: '20260804', open: 10.5, high: 10.9, low: 10.4, close: 10.8, pre_close: 10.5, vol: 1000 },
    { trade_date: '20260803', open: 10.1, high: 10.6, low: 10.0, close: 10.5, pre_close: 10.0, vol: 900 },
    { trade_date: '20260805', open: null, close: null }, // 停牌/缺失→过滤
  ])
  assert.equal(bars.length, 2)
  assert.equal(bars[0].date, '20260803')
  assert.equal(bars[1].date, '20260804')
})

test('mergeAdjFactor 以最新复权因子为基准合成后复权价', () => {
  // 除权场景：早期因子小、最新因子大。后复权=raw*factor/latestFactor。
  const daily = [
    { trade_date: '20260803', open: 10, high: 10, low: 10, close: 10, pre_close: 10, vol: 1 },
    { trade_date: '20260804', open: 5, high: 5, low: 5, close: 5, pre_close: 10, vol: 1 }, // 10派后除权到5
  ]
  const adj = [
    { trade_date: '20260803', adj_factor: 1 },
    { trade_date: '20260804', adj_factor: 2 },
  ]
  const merged = mergeAdjFactor(daily, adj)
  // latestFactor=2；第一天后复权=10*1/2=5，第二天=5*2/2=5 → 连续无跳空
  assert.equal(merged[0].hfqClose, 5)
  assert.equal(merged[1].hfqClose, 5)
})

test('toTsCode 正确映射沪深北交易所后缀', () => {
  assert.equal(toTsCode('600000'), '600000.SH')
  assert.equal(toTsCode('000001'), '000001.SZ')
  assert.equal(toTsCode('300750'), '300750.SZ')
  assert.equal(toTsCode('688981'), '688981.SH')
  assert.equal(toTsCode('600000.SH'), '600000.SH')
  assert.equal(toTsCode('abc'), null)
})

test('barsForBacktest 默认输出后复权价供策略使用', () => {
  const record = {
    bars: [{
      date: '20260803', open: 5, high: 5, low: 5, close: 5, preClose: 5, volume: 1,
      hfqOpen: 10, hfqHigh: 10, hfqLow: 10, hfqClose: 10, hfqPreClose: 10,
    }],
  }
  const adjusted = barsForBacktest(record)
  assert.equal(adjusted[0].close, 10)
  const raw = barsForBacktest(record, { adjusted: false })
  assert.equal(raw[0].close, 5)
})

test('resolveTushareToken 仅从环境变量读取并去空白', () => {
  assert.equal(resolveTushareToken({ TUSHARE_TOKEN: '  abc  ' }), 'abc')
  assert.equal(resolveTushareToken({}), null)
})
