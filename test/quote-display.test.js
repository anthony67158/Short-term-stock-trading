import test from 'node:test'
import assert from 'node:assert/strict'

import { quoteDisplayState } from '../shared/quoteDisplay.js'

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
