import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceObservationLevels,
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
    label: '观察价',
    price: 105,
    direction: 'GTE',
    status: 'PENDING',
    strict: true,
    currentDistancePct: 5,
    horizonPct: 5,
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
      ['WATCH_PULLBACK', 'PENDING'],
    ],
  )
  assert.equal(contract.review.operator, 'ANY')
  assert.equal(contract.review.allMet, false)
})

test('生成时已经越过的观察价不再进入未来复核条件', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      timing: '放量站上105元后重新判断',
      watchPrice: 105,
    },
    payload: payload(106),
  })

  assert.equal(contract.review.allMet, false)
  assert.deepEqual(contract.review.conditions, [])
  assert.match(contract.issues.join('；'), /方向已经满足/)
})

test('观望同时保留近期可达的回踩与突破两条路径', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      timing: '回踩96元企稳或放量站上105元后重新判断',
      pullbackWatchPrice: 96,
      breakoutWatchPrice: 105,
    },
    payload: payload(),
  })

  assert.deepEqual(
    adviceObservationLevels({ priceContract: contract }).map((level) => [
      level.key,
      level.direction,
      level.price,
      level.label,
    ]),
    [
      ['watch_pullback', 'LTE', 96, '回踩观察'],
      ['watch_breakout', 'GTE', 105, '突破观察'],
    ],
  )
  assert.equal(contract.review.operator, 'ANY')
  assert.equal(contract.review.allMet, false)
})

test('未给结构化观察价时从近期支撑与压力补齐双路径', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      timing: '等待量价确认',
    },
    payload: payload(),
  })

  assert.deepEqual(
    adviceObservationLevels({ priceContract: contract }).map((level) => [
      level.key,
      level.price,
      level.basis,
    ]),
    [
      ['watch_pullback', 98, 'quote.dayLow'],
      ['watch_breakout', 101, 'quote.dayHigh'],
    ],
  )
})

test('远离现价或方向已经满足的观察价不进入短线契约', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      timing: '回踩89.09元或放量突破120元后重新判断',
      pullbackWatchPrice: 89.09,
      breakoutWatchPrice: 120,
    },
    payload: {
      todayQuote: {
        price: 128.61,
        limitDownPrice: 115.75,
        limitUpPrice: 141.47,
      },
      tech: {
        atr: 3,
        support: 89.09,
        resistance: 120,
      },
    },
  })

  assert.deepEqual(adviceObservationLevels({ priceContract: contract }), [])
  assert.match(contract.issues.join('；'), /超出短线观察范围/)
  assert.match(contract.issues.join('；'), /方向已经满足/)
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

test('高于现价的压力位不能作为回踩买入执行价', () => {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      actionPlan: '放量站上105元买入',
      buyPrice: 105,
      stopPrice: 96,
      targetPrice: 110,
    },
    payload: payload(),
  })

  assert.equal(
    advicePriceLevel({ priceContract: contract }, 'entry'),
    null,
  )
  assert.equal(contract.validationStatus, 'REJECTED')
  assert.match(
    contract.issues.join('；'),
    /高于当前价.*不能作为回踩执行价/,
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
