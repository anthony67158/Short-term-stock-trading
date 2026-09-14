import { createHash } from 'node:crypto'

export const REVIEW_PRICE_CONTRACT_SCHEMA_VERSION =
  'review-price-contract.v1'

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MILLI_BPS_DENOMINATOR = 10_000_000n

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function scaledInteger(value, scale, maximum) {
  const number = finite(value)
  if (number == null || !(number >= 0) || number > maximum) return null
  const scaled = Math.round(number * scale)
  return Number.isSafeInteger(scaled) ? scaled : null
}

export function reviewPriceContract(value = {}) {
  const entryPriceMilliCny = scaledInteger(
    value.entryPrice,
    1000,
    1_000_000,
  )
  const stopPriceMilliCny = scaledInteger(
    value.stopPrice,
    1000,
    1_000_000,
  )
  const feeRateMilliBps = scaledInteger(
    value.feeRateBps,
    1000,
    10_000,
  )
  const slippageMilliBps = scaledInteger(
    value.slippageBps,
    1000,
    10_000,
  )
  const lotSize = finite(value.lotSize)
  const exitPolicyVersion = String(value.exitPolicyVersion || '')
  const observationPolicyVersion = String(
    value.observationPolicyVersion || '',
  )
  const priceRiskMilliCny = entryPriceMilliCny - stopPriceMilliCny
  const frictionMilliBps = feeRateMilliBps + slippageMilliBps * 2
  const coversTradingFriction = (
    Number.isSafeInteger(entryPriceMilliCny)
    && Number.isSafeInteger(priceRiskMilliCny)
    && Number.isSafeInteger(frictionMilliBps)
    && (
      BigInt(priceRiskMilliCny) * MILLI_BPS_DENOMINATOR
      > BigInt(entryPriceMilliCny) * BigInt(frictionMilliBps)
    )
  )
  if (
    !(entryPriceMilliCny > stopPriceMilliCny)
    || !(stopPriceMilliCny > 0)
    || feeRateMilliBps == null
    || slippageMilliBps == null
    || !Number.isSafeInteger(lotSize)
    || !(lotSize > 0)
    || !coversTradingFriction
    || typeof value.tPlusOne !== 'boolean'
    || !VERSION.test(exitPolicyVersion)
    || !VERSION.test(observationPolicyVersion)
  ) return null

  const canonical = {
    schemaVersion: REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
    entryPriceMilliCny,
    stopPriceMilliCny,
    priceRiskMilliCny,
    feeRateMilliBps,
    slippageMilliBps,
    lotSize,
    tPlusOne: value.tPlusOne,
    exitPolicyVersion,
    observationPolicyVersion,
  }
  return {
    canonical,
    hash: createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex'),
  }
}
