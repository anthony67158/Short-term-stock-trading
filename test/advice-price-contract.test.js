import test from 'node:test'
import assert from 'node:assert/strict'

import {
  advicePriceLevel,
  buildAdvicePriceContract,
  priceMatchesAdviceContract,
  sanitizedAdvicePriceContract,
} from '../shared/advicePriceContract.js'

const payload = (price = 100) => ({
  todayQuote: {
    price,
    open: 99,
    low: 98,
    high: 101,
    limitDownPrice: 90,
    limitUpPrice: 110,
    asOf: '2026-08-25 10:00:00',
  },
  tech: {
    atr: 2,
    support: 96,
    resistance: 105,
    buyZone: { low: 96, high: 98 },
    sellZone: { low: 104, high: 105 },
    stopLoss: 94,
    takeProfit: 106,
  },
  quant: {
    forecast: {
      targetLow: 104,
      targetMid: 105,
      targetHigh: 106,
    },
  },
})

test('观望价被编译为有方向、有依据的价格复核契约', () => {
  const advice = {
    action: '观望',
    actionPlan: '放量站上105元后重新判断',
    watchPrice: 105,
  }
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice,
    payload: payload(),
  })

  assert.deepEqual(advicePriceLevel({ priceContract: contract }, 'watch'), {
    key: 'watch',
    field: 'watchPrice',
    purpose: 'REVIEW_ONLY',
    price: 105,
    direction: 'GTE',
    status: 'PENDING',
    strict: true,
    basis: 'technical.resistance',
    basisPrice: 105,
    basisDistancePct: 0,
    tolerancePct: 3,
  })
  assert.deepEqual(
    contract.review.conditions.map((condition) => [
      condition.key,
      condition.status,
    ]),
    [
      ['WATCH_PRICE', 'PENDING'],
    ],
  )
  assert.equal(contract.review.allMet, false)
})

test('价格条件满足时复核契约进入全部满足状态', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      timing: '放量站上105元后重新判断',
      watchPrice: 105,
    },
    payload: payload(106),
  })

  assert.equal(contract.review.allMet, true)
  assert.deepEqual(
    contract.review.conditions.map((condition) => condition.status),
    ['MET'],
  )
})

test('远离所有行情技术量化锚点的价格不能成为严格价位', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      timing: '站上109.9元后重新判断',
      watchPrice: 109.9,
    },
    payload: payload(),
  })

  assert.equal(advicePriceLevel({ priceContract: contract }, 'watch'), null)
  assert.equal(contract.allPricesStrict, false)
  assert.match(contract.issues.join('；'), /缺少邻近/)
})

test('Judge只能使用价格契约中的精确价位', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      actionPlan: '回踩98元企稳后买入',
      buyPrice: 98,
      stopPrice: 94,
      targetPrice: 106,
    },
    payload: payload(),
  })
  const advice = { priceContract: contract }

  assert.equal(priceMatchesAdviceContract(advice, 'entry', 98), true)
  assert.equal(priceMatchesAdviceContract(advice, 'entry', 98.01), false)
  assert.equal(
    sanitizedAdvicePriceContract({
      priceContract: {
        ...contract,
        secret: 'not-public',
      },
    }).secret,
    undefined,
  )
})

test('买入区间上下界分别校验并记录证据来源', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '回调再买',
      buyPrice: 98,
      buyZone: '96~98元',
      stopPrice: 94,
      targetPrice: 106,
    },
    payload: payload(),
  })

  assert.deepEqual(contract.zones.buy, {
    low: 96,
    high: 98,
    strict: true,
    endpoints: [
      {
        key: 'low',
        price: 96,
        strict: true,
        basis: 'technical.support',
        basisPrice: 96,
        basisDistancePct: 0,
        tolerancePct: 3,
      },
      {
        key: 'high',
        price: 98,
        strict: true,
        basis: 'quote.dayLow',
        basisPrice: 98,
        basisDistancePct: 0,
        tolerancePct: 3,
      },
    ],
  })
})
