import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
  reviewPriceContract,
} from '../shared/reviewPriceContract.js'

const input = {
  stopPrice: 9.8,
  entryPrice: 10.2,
  feeRateBps: 6.1,
  slippageBps: 5,
  lotSize: 100,
  tPlusOne: true,
  exitPolicyVersion: 'trailing-exit.v1',
  observationPolicyVersion: 'trigger-review-observation.v1',
}

test('价格合同产生稳定的规范字段和跨语言金样哈希', () => {
  const actual = reviewPriceContract(input)

  assert.deepEqual(actual.canonical, {
    schemaVersion: REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
    entryPriceMilliCny: 10200,
    stopPriceMilliCny: 9800,
    priceRiskMilliCny: 400,
    feeRateMilliBps: 6100,
    slippageMilliBps: 5000,
    lotSize: 100,
    tPlusOne: true,
    exitPolicyVersion: 'trailing-exit.v1',
    observationPolicyVersion: 'trigger-review-observation.v1',
  })
  assert.equal(
    actual.hash,
    'f9ad80382299d84f729524a924796ee3ac7a18081f1f0e1618db7affe670fab9',
  )
})

test('字段顺序不影响价格合同哈希，价格变化必然改变哈希', () => {
  const reordered = Object.fromEntries(Object.entries(input).reverse())
  assert.equal(reviewPriceContract(reordered).hash, reviewPriceContract(input).hash)
  assert.notEqual(
    reviewPriceContract({ ...input, entryPrice: 10.201 }).hash,
    reviewPriceContract(input).hash,
  )
})

test('无效价格、费用、手数或版本失败关闭', () => {
  for (const patch of [
    { entryPrice: 9.8 },
    { stopPrice: Number.NaN },
    { feeRateBps: -1 },
    { slippageBps: Infinity },
    { lotSize: 0 },
    { tPlusOne: 'true' },
    { exitPolicyVersion: '../bad' },
    { observationPolicyVersion: '' },
  ]) {
    assert.equal(reviewPriceContract({ ...input, ...patch }), null)
  }
})
