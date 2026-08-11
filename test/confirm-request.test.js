import test from 'node:test'
import assert from 'node:assert/strict'

import confirmSignalHandler, { sanitizeConfirmationBody } from '../api/confirm_signal.js'
import { TRUSTED_ACCOUNT_REQUEST } from '../api/_account_auth.js'

test('确认接口只保留Judge需要的白名单字段', () => {
  const result = sanitizeConfirmationBody({
    alert: {
      id: 'a1',
      code: '600000',
      name: '浦发银行',
      type: 'price',
      op: 'gte',
      value: 10,
      phase: 'watching',
      watchingAt: Date.now() - 120000,
      watchingPrice: 10,
      note: '止盈',
      injected: 'drop',
    },
    advice: {
      action: '加仓',
      actionPlan: '回踩10元企稳后加仓1手',
      exitTiming: '站回VWAP再加',
      addPrice: 10,
      stopPrice: 9.6,
      targetPrice: 11,
      riskReward: '2.5:1',
      fundNote: '主力资金连续流入',
      bearCase: '跌破支撑则判断错误',
      invalidation: '跌破9.6元失效',
      private: 'drop',
    },
    quote: { price: 10.1, pct: 1, unknown: 'drop' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.alert.injected, undefined)
  assert.equal(result.value.advice.private, undefined)
  assert.equal(result.value.advice.action, '加仓')
  assert.equal(result.value.advice.addPrice, 10)
  assert.equal(result.value.advice.stopPrice, 9.6)
  assert.equal(result.value.advice.riskReward, '2.5:1')
  assert.equal(result.value.advice.fundNote, '主力资金连续流入')
  assert.equal(result.value.advice.bearCase, '跌破支撑则判断错误')
  assert.equal(result.value.quote.unknown, undefined)
})

test('确认接口拒绝非watching、非法代码和非法价格', () => {
  assert.equal(sanitizeConfirmationBody({ alert: { code: 'bad' } }).ok, false)
  assert.equal(sanitizeConfirmationBody({
    alert: { code: '600000', type: 'price', op: 'gte', value: 10, phase: 'armed' },
  }).ok, false)
  assert.equal(sanitizeConfirmationBody({
    alert: { code: '600000', type: 'price', op: 'gte', value: -1, phase: 'watching' },
  }).ok, false)
  assert.equal(sanitizeConfirmationBody({
    alert: { code: '600000', type: 'price', op: 'gte', value: 10, phase: 'watching' },
  }).ok, false)
})

test('今日无可卖仓位时确认接口直接返回 T+1 等待，不调用 Judge', async () => {
  let response = null
  const req = {
    method: 'POST',
    headers: {},
    [TRUSTED_ACCOUNT_REQUEST]: true,
    socket: { remoteAddress: 't1-test' },
    body: {
      alert: {
        id: 'a1',
        code: '000636',
        name: '风华高科',
        type: 'price',
        op: 'lte',
        value: 12,
        note: '止损',
        phase: 'watching',
        watchingAt: Date.now() - 120000,
        watchingPrice: 12,
        boughtTodayQty: 1,
        sellableTodayQty: 0,
        nextTradeDay: '下一交易日',
      },
      quote: { price: 12 },
    },
  }
  const res = {
    setHeader() {},
    status(code) { this.statusCode = code; return this },
    send(value) { response = JSON.parse(value); return this },
    end(value) { response = JSON.parse(value); return this },
  }

  await confirmSignalHandler(req, res)

  assert.equal(response.ok, true)
  assert.equal(response.decision, 'wait')
  assert.equal(response.source, 't1')
  assert.equal(response.policy, 't1-blocked')
  assert.match(response.reason, /今日不可卖/)
})
