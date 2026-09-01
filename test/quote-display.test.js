import test from 'node:test'
import assert from 'node:assert/strict'

import {
  quoteDisplayState,
  stockDetailHeaderState,
} from '../shared/quoteDisplay.js'

test('旧接口返回0时卡片回退最近收盘且不可触发交易', () => {
  assert.deepEqual(
    quoteDisplayState({
      price: 0,
      pct: 0,
      prevClose: 15.44,
    }),
    {
      price: 15.44,
      livePrice: null,
      pct: null,
      label: '最近收盘',
      status: 'PREVIOUS_CLOSE',
    },
  )
})

test('竞价价可以展示但不能作为盘中执行价', () => {
  assert.deepEqual(
    quoteDisplayState({
      price: 15.6,
      pct: 1.04,
      prevClose: 15.44,
      priceStatus: 'AUCTION',
      priceLabel: '竞价',
      isLivePrice: false,
    }),
    {
      price: 15.6,
      livePrice: null,
      pct: 1.04,
      label: '竞价',
      status: 'AUCTION',
    },
  )
})

test('连续竞价现价同时用于展示和交易触发', () => {
  assert.deepEqual(
    quoteDisplayState({
      price: 15.6,
      pct: 1.04,
      prevClose: 15.44,
      priceStatus: 'LIVE',
      priceLabel: '',
      isLivePrice: true,
    }),
    {
      price: 15.6,
      livePrice: 15.6,
      pct: 1.04,
      label: '',
      status: 'LIVE',
    },
  )
})

test('个股详情头部优先显示实时价而不是上一根日K收盘价', () => {
  assert.deepEqual(
    stockDetailHeaderState({
      price: 54.73,
      pct: -8.19,
      prevClose: 59.61,
      tradeDate: '2026-09-01',
      priceStatus: 'LIVE',
      isLivePrice: true,
    }, {
      price: 59.61,
      pct: 10,
    }),
    {
      price: 54.73,
      pct: -8.19,
      source: 'quote',
      sourceLabel: '实时行情',
      live: true,
      status: 'LIVE',
    },
  )
})

test('实时报价不可用时个股详情才回退最新K线', () => {
  assert.deepEqual(
    stockDetailHeaderState({}, {
      price: 58.4,
      pct: 1.2,
    }),
    {
      price: 58.4,
      pct: 1.2,
      source: 'candle',
      sourceLabel: '最新K线',
      live: false,
      status: 'KLINE',
    },
  )
})

test('K线尚未返回时个股详情仍可先展示实时行情', () => {
  assert.equal(
    stockDetailHeaderState({
      price: 54.73,
      pct: -8.19,
      priceStatus: 'LIVE',
      isLivePrice: true,
    }, null).price,
    54.73,
  )
})
