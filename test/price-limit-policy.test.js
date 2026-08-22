import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyPriceLimit,
  isNearPriceLimit,
  priceLimitRatio,
} from '../shared/priceLimitPolicy.js'
import { toSecid, withPriceLimitState } from '../api/quote.js'
import { __test as cronAlert } from '../api/cron_alert.js'
import { beijingDayKey } from '../shared/tradingCalendar.js'

test('按证券板块和风险警示状态返回正确涨跌幅限制', () => {
  assert.equal(priceLimitRatio({ code: '600519', name: '贵州茅台' }), 0.1)
  assert.equal(priceLimitRatio({ code: '000001', name: '平安银行' }), 0.1)
  assert.equal(priceLimitRatio({ code: '300750', name: '宁德时代' }), 0.2)
  assert.equal(priceLimitRatio({ code: '688981', name: '中芯国际' }), 0.2)
  assert.equal(priceLimitRatio({ code: '920001', name: '北交示例' }), 0.3)
  assert.equal(priceLimitRatio({ code: '430047', name: '北交示例' }), 0.3)
  assert.equal(priceLimitRatio({ code: '600001', name: '*ST示例' }), 0.05)
})

test('注册制板块风险警示股票仍采用板块20%限制', () => {
  assert.equal(priceLimitRatio({ code: '300001', name: 'ST示例' }), 0.2)
  assert.equal(priceLimitRatio({ code: '688001', name: '*ST示例' }), 0.2)
})

test('临近涨跌停按各自限制的95%判断而不是固定9.5%', () => {
  assert.equal(isNearPriceLimit({ code: '600001', name: '主板', pct: 9.5 }, 'up'), true)
  assert.equal(isNearPriceLimit({ code: '300001', name: '创业板', pct: 9.5 }, 'up'), false)
  assert.equal(isNearPriceLimit({ code: '300001', name: '创业板', pct: 19 }, 'up'), true)
  assert.equal(isNearPriceLimit({ code: '688001', name: '科创板', pct: -19 }, 'down'), true)
  assert.equal(isNearPriceLimit({ code: '920001', name: '北交所', pct: 28.5 }, 'up'), true)
  assert.equal(isNearPriceLimit({ code: '600001', name: 'ST示例', pct: -4.75 }, 'down'), true)
})

test('涨跌停状态使用板块阈值且拒绝无效涨跌幅', () => {
  assert.deepEqual(classifyPriceLimit({ code: '300001', name: '创业板', pct: 10 }), {
    isLimitUp: false,
    isLimitDown: false,
  })
  assert.deepEqual(classifyPriceLimit({ code: '300001', name: '创业板', pct: 19.7 }), {
    isLimitUp: false,
    isLimitDown: false,
  })
  assert.deepEqual(classifyPriceLimit({ code: '300001', name: '创业板', pct: 19.8 }), {
    isLimitUp: true,
    isLimitDown: false,
  })
  assert.deepEqual(classifyPriceLimit({ code: '920001', name: '北交所', pct: 29.7 }), {
    isLimitUp: false,
    isLimitDown: false,
  })
  assert.deepEqual(classifyPriceLimit({ code: '920001', name: '北交所', pct: 29.8 }), {
    isLimitUp: true,
    isLimitDown: false,
  })
  assert.deepEqual(classifyPriceLimit({ code: '600001', name: 'ST示例', pct: -4.9 }), {
    isLimitUp: false,
    isLimitDown: true,
  })
  assert.deepEqual(classifyPriceLimit({ code: '600001', name: '主板', pct: null }), {
    isLimitUp: false,
    isLimitDown: false,
  })
})

test('报价接口按证券板块生成涨跌停标记', () => {
  assert.equal(withPriceLimitState({
    code: '300001',
    name: '创业板示例',
    pct: 10,
  }).isLimitUp, false)
  assert.equal(withPriceLimitState({
    code: '600001',
    name: 'ST示例',
    pct: 4.9,
  }).isLimitUp, true)
})

test('北交所新旧代码使用正确的东方财富市场前缀', () => {
  assert.equal(toSecid('920001'), '0.920001')
  assert.equal(toSecid('430047'), '0.430047')
  assert.equal(toSecid('600519'), '1.600519')
})

test('FC预警按股票自身限制判断并显示动态阈值', () => {
  const growthAlert = { type: 'limitup', code: '300001', name: '创业板示例' }
  const stAlert = { type: 'limitdown', code: '600001', name: 'ST示例' }
  const now = Date.parse('2026-08-21T02:00:00.000Z')
  const tradeDate = beijingDayKey(now)
  const originalNow = Date.now
  Date.now = () => now
  try {
    assert.equal(cronAlert.hit(growthAlert, { pct: 9.5, price: 10, tradeDate }), null)
    assert.match(cronAlert.hit(growthAlert, { pct: 19, price: 10, tradeDate }), /临近\/触及涨停/)
    assert.match(cronAlert.hit(stAlert, { pct: -4.75, price: 10, tradeDate }), /临近\/触及跌停/)
    assert.equal(cronAlert.describeAlert(growthAlert), '临近涨停(涨幅≥19%)')
    assert.equal(cronAlert.describeAlert(stAlert), '临近跌停(跌幅≥4.75%)')
  } finally {
    Date.now = originalNow
  }
})
