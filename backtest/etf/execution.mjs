import { tradeFees } from '../../shared/ashareStrategyExecution.js'

export function etfFees(side, amount, spec) {
  return tradeFees(side, amount, {
    commissionRate: spec.commissionRate,
    minimumCommission: spec.minimumCommission,
    stampDutyRate: 0,
    transferRate: 0,
  })
}

export function validateStockOrder({ code, quantity, permissions = {} }) {
  if (!/^\d{6}$/.test(code) || !Number.isInteger(quantity) || quantity <= 0) {
    return 'INVALID_ORDER'
  }
  if (/^68/.test(code)) {
    if (permissions.star !== true) return 'STAR_PERMISSION_REQUIRED'
    if (quantity < 200) return 'STAR_MINIMUM_200'
  } else {
    if (/^30/.test(code) && permissions.chinext !== true) return 'CHINEXT_PERMISSION_REQUIRED'
    if (/^(4|8|92)/.test(code) && permissions.bse !== true) return 'BSE_PERMISSION_REQUIRED'
    if (quantity % 100 !== 0) return 'INVALID_BUY_LOT'
  }
  return null
}

// Research-only ETF execution. Never substitute this for a production action decision.
export function etfFill({ side, price, quantity, preClose, asset, spec, slippageBps }) {
  if (!['BUY', 'SELL'].includes(side) || !Number.isInteger(quantity)
      || quantity <= 0 || (side === 'BUY' && quantity % 100 !== 0)
      || !Number.isFinite(price) || price <= 0
      || !Number.isFinite(preClose) || preClose <= 0
      || !Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new Error('INVALID_ETF_ORDER')
  }
  const upper = Math.round(preClose * (1 + asset.limitRatio) * 1000) / 1000
  const lower = Math.round(preClose * (1 - asset.limitRatio) * 1000) / 1000
  const slipped = price * (1 + (side === 'BUY' ? 1 : -1) * slippageBps / 10000)
  const fillPrice = (side === 'BUY' ? Math.ceil(slipped * 1000 - 1e-8)
    : Math.floor(slipped * 1000 + 1e-8)) / 1000
  if ((side === 'BUY' && (price >= upper || fillPrice > upper))
      || (side === 'SELL' && (price <= lower || fillPrice < lower))) {
    return { fillable: false, reason: 'PRICE_LIMIT' }
  }
  const gross = Math.round(fillPrice * quantity * 100) / 100
  const fees = etfFees(side, gross, spec)
  return {
    fillable: true, fillPrice, quantity, fees,
    cashFlow: side === 'BUY' ? -(gross + fees.total) : gross - fees.total,
  }
}
