import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeMoneyflow,
  normalizeLimitList,
  normalizeTopInst,
  normalizeDailyBasic,
} from '../backtest/data/extendedData.js'

test('normalizeMoneyflow 主力净流入=大单+特大单净额', () => {
  const rows = normalizeMoneyflow([{
    trade_date: '20260109',
    buy_sm_amount: 100, sell_sm_amount: 120, // 小单净 -20
    buy_lg_amount: 300, sell_lg_amount: 200, // 大单净 +100
    buy_elg_amount: 150, sell_elg_amount: 100, // 特大单净 +50
    net_mf_amount: 130,
  }])
  assert.equal(rows[0].date, '20260109')
  assert.equal(rows[0].mainNetWan, 150) // 100+50
  assert.equal(rows[0].retailNetWan, -20)
  assert.equal(rows[0].netMfWan, 130)
})

test('normalizeMoneyflow 缺字段按0处理不崩', () => {
  const rows = normalizeMoneyflow([{ trade_date: '20260109' }])
  assert.equal(rows[0].mainNetWan, 0)
  assert.equal(rows[0].retailNetWan, 0)
})

test('normalizeLimitList 保留封单金额与类型', () => {
  const rows = normalizeLimitList([{
    trade_date: '20260115', ts_code: '600000.SH', name: '浦发银行',
    industry: '银行', close: 11, pct_chg: 10, amount: 5e5,
    limit_amount: 2e5, limit: 'U',
  }])
  assert.equal(rows[0].code, '600000.SH')
  assert.equal(rows[0].limitType, 'U')
  assert.equal(rows[0].limitAmount, 2e5)
})

test('normalizeTopInst 保留席位与净买入', () => {
  const rows = normalizeTopInst([{
    trade_date: '20260115', ts_code: '300750.SZ',
    exalter: '中信证券某营业部', buy: 5000, sell: 1000, net_buy: 4000,
  }])
  assert.equal(rows[0].seat, '中信证券某营业部')
  assert.equal(rows[0].netBuy, 4000)
})

test('normalizeDailyBasic 保留换手率与量比并升序', () => {
  const rows = normalizeDailyBasic([
    { trade_date: '20260110', turnover_rate: 3.2, volume_ratio: 1.8, circ_mv: 5e6 },
    { trade_date: '20260109', turnover_rate: 2.1, volume_ratio: 1.2, circ_mv: 5e6 },
  ])
  assert.equal(rows[0].date, '20260109')
  assert.equal(rows[1].turnoverRate, 3.2)
  assert.equal(rows[1].volumeRatio, 1.8)
})
