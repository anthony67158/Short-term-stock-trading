import { featuresAt } from './data.mjs'
import { etfFill, etfFees } from './execution.mjs'

const money = value => Math.round((value + Number.EPSILON) * 100) / 100
function week(date) {
  const day = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7)
  return day.toISOString().slice(0, 10)
}

export function selectTargets(assets, date, spec, model) {
  if (model === 'cash') return []
  const eligible = assets.map(asset => ({ asset, feature: featuresAt(asset, date, spec) }))
    .filter(item => item.feature)
  if (['static_risk_matched', 'buy_hold_reference'].includes(model)) {
    return eligible.filter(item => spec.staticCodes.includes(item.asset.code))
  }
  if (model === 'monthly_trend') {
    return eligible.filter(item => spec.staticCodes.includes(item.asset.code) && item.feature.monthlyPositive)
  }
  if (model !== 'weekly_rotation') throw new Error('UNKNOWN_STRATEGY')
  const groups = new Set()
  return eligible.filter(item => item.feature.momentum > 0)
    .sort((a, b) => b.feature.momentum - a.feature.momentum || a.asset.code.localeCompare(b.asset.code))
    .filter(item => {
      if (groups.has(item.asset.group)) return false
      groups.add(item.asset.group)
      return true
    }).slice(0, spec.maxPositions)
}

export function runPortfolio({ calendar, assets, spec, model, slippageBps }) {
  if (!spec.models.includes(model) && model !== 'buy_hold_reference') throw new Error('UNKNOWN_STRATEGY')
  const dates = calendar.filter(date => date >= spec.start && date <= spec.end)
  const assetMap = new Map(assets.map(asset => [asset.code, asset]))
  const positions = new Map()
  const entitlements = []
  const fills = [], trades = [], events = [], curve = [], signals = []
  let cash = spec.initialCash, pending = null, totalFees = 0, totalDividends = 0
  function value(date, field = 'close') {
    let holdings = 0
    for (const [code, position] of positions) {
      const bar = assetMap.get(code).byDate.get(date)
      if (!bar) throw new Error('UNPRICED_POSITION')
      holdings += position.quantity * bar[field]
    }
    const receivable = entitlements.filter(item => item.exDate <= date && !item.paid)
      .reduce((sum, item) => sum + item.amount, 0)
    return { holdings, receivable, equity: money(cash + holdings + receivable) }
  }
  function sell(code, date, price, reason) {
    const asset = assetMap.get(code), position = positions.get(code), bar = asset.byDate.get(date)
    if (asset.tPlusOne && position.acquiredDate === date) {
      position.exitPending = true
      events.push({ date, code, reason: 'T_PLUS_ONE_LOCKED' })
      return false
    }
    if (bar.vol <= 0) {
      position.exitPending = true
      events.push({ date, code, reason: 'NO_LIQUIDITY' })
      return false
    }
    const result = etfFill({ side: 'SELL', price, quantity: position.quantity,
      preClose: bar.pre_close, asset, spec, slippageBps })
    if (!result.fillable) {
      position.exitPending = true
      events.push({ date, code, reason: result.reason })
      return false
    }
    cash = money(cash + result.cashFlow)
    totalFees += result.fees.total
    fills.push({ date, code, side: 'SELL', reason, ...result })
    trades.push({ code, entryDate: position.acquiredDate, exitDate: date,
      quantity: position.quantity, pnl: money(result.cashFlow - position.cost),
      dividendEntitlement: position.dividendEntitlement })
    positions.delete(code)
    return true
  }
  for (let index = 0; index < dates.length; index++) {
    const date = dates[index], sold = new Set()
    for (const asset of assets) {
      const split = asset.splits.find(item => item.priceDate === date)
      if (!split) continue
      const position = positions.get(asset.code)
      if (position) {
        position.quantity = Math[split.rounding](position.quantity * split.ratio)
        position.stop /= split.ratio
        position.peak /= split.ratio
        events.push({ date, code: asset.code, reason: 'SPLIT', quantity: position.quantity })
      }
      const target = pending?.targets.find(item => item.code === asset.code)
      if (target) {
        target.quantity = Math.floor(target.quantity * split.ratio / 100) * 100
        target.averageShares *= split.ratio
        target.stopDistance /= split.ratio
      }
    }
    // Entitlements are captured on record-date close, booked ex-date and paid later.
    for (const entitlement of entitlements) {
      if (!entitlement.paid && date >= entitlement.payDate) {
        cash = money(cash + entitlement.amount)
        totalDividends += entitlement.amount
        entitlement.paid = true
      }
    }
    for (const [code, position] of positions) {
      const asset = assetMap.get(code)
      const dividend = asset.dividends.find(item => item.ex_date === date)
      if (dividend) {
        position.stop = Math.max(0.001, position.stop - dividend.div_cash)
        position.peak = Math.max(0.001, position.peak - dividend.div_cash)
      }
      const bar = asset.byDate.get(date)
      if (model !== 'buy_hold_reference' && (position.exitPending || bar.open <= position.stop)) {
        if (sell(code, date, bar.open, 'GAP_OR_PENDING_STOP')) sold.add(code)
      }
    }
    if (pending) {
      const desired = new Set(pending.targets.map(item => item.code))
      for (const code of [...positions.keys()]) {
        if (!desired.has(code) && sell(code, date, assetMap.get(code).byDate.get(date).open, 'SIGNAL_EXIT')) {
          sold.add(code)
        }
      }
      for (const target of pending.targets) {
        if (positions.has(target.code) || sold.has(target.code) || positions.size >= spec.maxPositions) continue
        const asset = assetMap.get(target.code), bar = asset.byDate.get(date)
        const equity = value(date, 'open').equity
        const riskPerShare = Math.max(target.stopDistance, bar.open * spec.gapStress)
        if (!(target.stopDistance > 0 && target.stopDistance < bar.open)) {
          events.push({ date, code: target.code, reason: 'INVALID_STOP_DISTANCE' })
          continue
        }
        let openRisk = 0
        for (const [code, pos] of positions) {
          const price = assetMap.get(code).byDate.get(date).open
          openRisk += pos.quantity * Math.max(price - pos.stop, price * spec.gapStress)
        }
        const maxRisk = Math.max(0, Math.min(equity * spec.riskPerPosition,
          equity * spec.maxOpenRisk - openRisk))
        let quantity = Math.floor(Math.min(
          target.quantity, maxRisk / riskPerShare,
          equity * spec.maxWeight / bar.open,
          target.averageShares * 0.001,
          (cash - equity * spec.cashBuffer) / bar.open,
        ) / 100) * 100
        let result = null
        while (quantity > 0) {
          result = etfFill({ side: 'BUY', price: bar.open, quantity,
            preClose: bar.pre_close, asset, spec, slippageBps })
          if (!result.fillable) break
          if (-result.cashFlow <= cash - equity * spec.cashBuffer
              && (result.fillPrice * quantity) <= equity * spec.maxWeight
              && quantity * Math.max(riskPerShare, result.fillPrice * spec.gapStress)
                + result.fees.total
                + etfFees('SELL', result.fillPrice * quantity, spec).total <= maxRisk) break
          quantity -= 100
        }
        if (!(quantity > 0) || bar.vol <= 0 || !result?.fillable) {
          events.push({ date, code: target.code, reason: result?.reason || 'CASH_RISK_OR_LIQUIDITY' })
          continue
        }
        cash = money(cash + result.cashFlow)
        totalFees += result.fees.total
        positions.set(target.code, {
          quantity, acquiredDate: date, cost: -result.cashFlow,
          stop: result.fillPrice - target.stopDistance, peak: result.fillPrice,
          dividendEntitlement: 0, exitPending: false,
        })
        fills.push({ date, signalDate: pending.date, code: target.code, side: 'BUY', ...result,
          riskBudget: maxRisk,
          stressedLossIncludingFees: quantity * Math.max(riskPerShare, result.fillPrice * spec.gapStress)
            + result.fees.total + etfFees('SELL', result.fillPrice * quantity, spec).total,
        })
      }
      pending = null
    }
    for (const [code, position] of positions) {
      const asset = assetMap.get(code), bar = asset.byDate.get(date)
      // Test the previously known stop first; today's high only raises tomorrow's stop.
      if (model !== 'buy_hold_reference' && bar.low <= position.stop && !position.exitPending) {
        if (sell(code, date, Math.min(bar.open, position.stop), 'HARD_OR_TRAILING_STOP')) continue
      }
      const feature = featuresAt(asset, date, spec)
      position.peak = Math.max(position.peak, bar.high)
      if (feature) position.stop = Math.max(position.stop, position.peak - spec.atrMultiple * feature.atr)
    }
    for (const [code, position] of positions) {
      for (const dividend of assetMap.get(code).dividends.filter(item => item.record_date === date)) {
        const amount = money(dividend.div_cash * position.quantity)
        entitlements.push({ code, amount, exDate: dividend.ex_date, payDate: dividend.pay_date, paid: false })
        position.dividendEntitlement += amount
      }
    }
    const mark = value(date)
    if (cash < -0.005 || !Number.isFinite(mark.equity)) throw new Error('LEDGER_INVARIANT_FAILED')
    curve.push({ date, cash, holdings: money(mark.holdings), receivable: money(mark.receivable),
      equity: mark.equity, positions: positions.size })
    const next = calendar[calendar.indexOf(date) + 1]
    // The first evaluation close creates the initial orders for the next session.
    const first = index === 0
    const rebalance = model !== 'buy_hold_reference' && next && (model === 'weekly_rotation'
      ? week(next) !== week(date)
      : next.slice(0, 6) !== date.slice(0, 6))
    if (rebalance || first) {
      const targets = selectTargets(assets, date, spec, model)
      pending = {
        date, targets: targets.map(({ asset, feature }) => ({
          code: asset.code, averageShares: feature.averageShares,
          stopDistance: spec.atrMultiple * feature.atr,
          quantity: Math.floor(Math.min(mark.equity * spec.maxWeight / feature.price,
            mark.equity * spec.riskPerPosition / Math.max(spec.atrMultiple * feature.atr,
              feature.price * spec.gapStress)) / 100) * 100,
        })),
      }
      signals.push(structuredClone(pending))
    }
  }
  let peak = spec.initialCash, maxDrawdown = 0
  for (const item of curve) {
    peak = Math.max(peak, item.equity)
    maxDrawdown = Math.max(maxDrawdown, 1 - item.equity / peak)
  }
  const final = curve.at(-1)
  const years = (Date.parse(`${spec.end.slice(0, 4)}-${spec.end.slice(4, 6)}-${spec.end.slice(6)}`)
    - Date.parse(`${spec.start.slice(0, 4)}-${spec.start.slice(4, 6)}-${spec.start.slice(6)}`)) / 86400000 / 365.25
  const annual = {}
  let previous = spec.initialCash
  for (const year of [...new Set(dates.map(date => date.slice(0, 4)))]) {
    const last = curve.filter(item => item.date.startsWith(year)).at(-1).equity
    annual[year] = { startEquity: previous, endEquity: last, returnPct: (last / previous - 1) * 100 }
    previous = last
  }
  return {
    model, slippageBps, productionEligible: false,
    finalEquity: final.equity, netPnl: money(final.equity - spec.initialCash),
    returnPct: (final.equity / spec.initialCash - 1) * 100,
    cagrPct: ((final.equity / spec.initialCash) ** (1 / years) - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100, fees: money(totalFees), dividendsPaid: money(totalDividends),
    averageExposurePct: curve.reduce((sum, item) => sum + item.holdings / item.equity, 0) / curve.length * 100,
    annual, fills, trades, events, signals, curve,
    openPositions: Object.fromEntries(positions), unsettledDividends: entitlements.filter(item => !item.paid),
  }
}
