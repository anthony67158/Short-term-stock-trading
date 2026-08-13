import { priceLimitRatio } from './priceLimitPolicy.js'

export const A_SHARE_STANDARD_FEE_POLICY = Object.freeze({
  policyId: 'A_SHARE_STANDARD_V1',
  commissionRate: 0.0003,
  minimumCommission: 5,
  stampDutyRate: 0.0005,
  transferRate: 0.00001,
})

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function money(value) {
  return +Number(value).toFixed(2)
}

function priceTick(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

function normalizedDate(value) {
  const compact = String(value || '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function historicalPriceLimitRatio(security = {}, tradeDate = null) {
  const code = String(security.code || '').trim()
  const name = String(security.name || '')
  const date = normalizedDate(tradeDate)
  if (/^(68)/.test(code)) return 0.2
  if (/^(30)/.test(code)) {
    if (!date || date >= '20200824') return 0.2
    return /(?:\*?ST)/i.test(name) ? 0.05 : 0.1
  }
  if (/^(4|8|92)/.test(code)) return 0.3
  if (/(?:\*?ST)/i.test(name)) return 0.05
  return priceLimitRatio(security)
}

export function ashareLimitPrices(
  security,
  previousClose,
  tradeDate = null,
) {
  const close = finite(previousClose)
  if (!(close > 0)) throw new Error('previousClose必须为正有限数')
  const ratio = historicalPriceLimitRatio(security, tradeDate)
  return {
    lower: priceTick(close * (1 - ratio)),
    upper: priceTick(close * (1 + ratio)),
    ratio,
  }
}

export function executionPrice(openPrice, side, slippageBps = 5) {
  const price = finite(openPrice)
  const bps = finite(slippageBps)
  const normalizedSide = String(side || '').toUpperCase()
  if (!(price > 0)) throw new Error('openPrice必须为正有限数')
  if (!(bps >= 0)) throw new Error('slippageBps必须为非负有限数')
  if (!['BUY', 'SELL'].includes(normalizedSide)) {
    throw new Error('side只支持BUY或SELL')
  }
  const multiplier = normalizedSide === 'BUY'
    ? 1 + bps / 10000
    : 1 - bps / 10000
  return +Number(price * multiplier).toFixed(6)
}

export function tradeFees(
  side,
  grossAmount,
  policy = A_SHARE_STANDARD_FEE_POLICY,
) {
  const amount = finite(grossAmount)
  const normalizedSide = String(side || '').toUpperCase()
  if (!(amount > 0)) throw new Error('grossAmount必须为正有限数')
  if (!['BUY', 'SELL'].includes(normalizedSide)) {
    throw new Error('side只支持BUY或SELL')
  }
  const rawCommission = Math.max(
    Number(policy.minimumCommission),
    amount * Number(policy.commissionRate),
  )
  const rawStampDuty = normalizedSide === 'SELL'
    ? amount * Number(policy.stampDutyRate)
    : 0
  const rawTransfer = amount * Number(policy.transferRate)
  return {
    commission: money(rawCommission),
    stampDuty: money(rawStampDuty),
    transfer: money(rawTransfer),
    total: money(rawCommission + rawStampDuty + rawTransfer),
  }
}

function rejected(reason, details = {}) {
  return {
    fillable: false,
    reason,
    ...details,
  }
}

export function assessAshareExecution({
  side,
  security = {},
  tradeDate,
  acquiredDate,
  previousClose,
  openPrice,
  volume,
  quantity,
  lotSize = 100,
  slippageBps = 5,
  tPlusOne = true,
  rejectLimitUpBuy = true,
  rejectLimitDownSell = true,
  feePolicy = A_SHARE_STANDARD_FEE_POLICY,
} = {}) {
  const normalizedSide = String(side || '').toUpperCase()
  if (!['BUY', 'SELL'].includes(normalizedSide)) {
    return rejected('INVALID_SIDE')
  }
  const shares = finite(quantity)
  const lot = finite(lotSize)
  if (!(Number.isInteger(shares) && shares > 0)) {
    return rejected('INVALID_QUANTITY')
  }
  if (
    normalizedSide === 'BUY'
    && (!(Number.isInteger(lot) && lot > 0) || shares % lot !== 0)
  ) {
    return rejected('INVALID_BUY_LOT')
  }
  const open = finite(openPrice)
  const tradedVolume = finite(volume)
  if (!(open > 0) || !(tradedVolume > 0)) {
    return rejected('SUSPENDED_OR_NO_LIQUIDITY')
  }
  const currentDate = normalizedDate(tradeDate)
  if (!currentDate) return rejected('INVALID_TRADE_DATE')
  if (normalizedSide === 'SELL' && tPlusOne) {
    const boughtOn = normalizedDate(acquiredDate)
    if (!boughtOn) return rejected('ACQUISITION_DATE_REQUIRED')
    if (currentDate <= boughtOn) return rejected('T_PLUS_ONE_LOCKED')
  }

  let limits
  try {
    limits = ashareLimitPrices(security, previousClose, currentDate)
  } catch {
    return rejected('INVALID_PREVIOUS_CLOSE')
  }
  if (
    normalizedSide === 'BUY'
    && rejectLimitUpBuy
    && open >= limits.upper
  ) {
    return rejected('LIMIT_UP_UNFILLED', { limits })
  }
  if (
    normalizedSide === 'SELL'
    && rejectLimitDownSell
    && open <= limits.lower
  ) {
    return rejected('LIMIT_DOWN_UNFILLED', { limits })
  }

  const fillPrice = executionPrice(open, normalizedSide, slippageBps)
  const grossAmount = money(fillPrice * shares)
  const fees = tradeFees(normalizedSide, grossAmount, feePolicy)
  const cashFlow = normalizedSide === 'BUY'
    ? money(-(grossAmount + fees.total))
    : money(grossAmount - fees.total)
  return {
    fillable: true,
    reason: null,
    side: normalizedSide,
    tradeDate: currentDate,
    quantity: shares,
    fillPrice,
    grossAmount,
    fees,
    cashFlow,
    limits,
  }
}
