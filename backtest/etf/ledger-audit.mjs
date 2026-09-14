import assert from 'node:assert/strict'

const cents = value => Math.round(value * 100)
const near = (actual, expected, label) => {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 0.011, `${label}: ${actual} != ${expected}`)
}

// Reconstruct only from fills + market data + corporate actions, never engine cash balances.
export function auditLedger(run, { assets, spec }) {
  const byCode = new Map(assets.map(asset => [asset.code, asset]))
  const positions = new Map()
  const receivables = []
  const attribution = Object.fromEntries(assets.map(asset => [asset.code, {
    cashFlowCents: 0, dividendCents: 0, feesCents: 0, trades: 0,
  }]))
  const fillsByDate = new Map()
  for (const fill of run.fills) {
    assert.ok(run.curve.some(row => row.date === fill.date), 'FILL_OUTSIDE_CALENDAR')
    assert.ok(['BUY', 'SELL'].includes(fill.side) && byCode.has(fill.code), 'INVALID_FILL')
    assert.ok(Number.isInteger(fill.quantity) && fill.quantity > 0 && fill.fillPrice > 0, 'INVALID_FILL_SIZE')
    if (!fillsByDate.has(fill.date)) fillsByDate.set(fill.date, [])
    fillsByDate.get(fill.date).push(fill)
  }
  let cash = cents(spec.initialCash), fees = 0, paid = 0
  let observations = 0, maxCashError = 0, maxEquityError = 0
  const actualDates = run.curve.map(row => row.date)
  assert.deepEqual(actualDates, [...new Set(actualDates)].sort(), 'DUPLICATE_OR_UNORDERED_DATES')
  for (const row of run.curve) {
    const date = row.date
    for (const [code, position] of positions) {
      const split = byCode.get(code).splits.find(item => item.priceDate === date)
      if (split) position.quantity = Math[split.rounding](position.quantity * split.ratio)
    }
    for (const claim of receivables) {
      if (!claim.paid && claim.payDate <= date) {
        cash += claim.amount
        paid += claim.amount
        attribution[claim.code].dividendCents += claim.amount
        claim.paid = true
      }
    }
    for (const fill of fillsByDate.get(date) || []) {
      const asset = byCode.get(fill.code), bar = asset.byDate.get(date)
      assert.ok(bar && bar.vol > 0, 'NO_TRADING_EVIDENCE')
      near(fill.fillPrice * 1000, Math.round(fill.fillPrice * 1000), 'PRICE_TICK')
      const gross = cents(fill.fillPrice * fill.quantity)
      // Match the existing fee contract's decimal rounding, without calling its calculator.
      const commission = cents(Number(Math.max(spec.minimumCommission,
        gross / 100 * spec.commissionRate).toFixed(2)))
      assert.equal(cents(fill.fees.total), commission, 'FEES_MISMATCH')
      assert.equal(fill.fees.stampDuty, 0, 'ETF_STAMP_DUTY')
      assert.equal(fill.fees.transfer, 0, 'ETF_TRANSFER_FEE')
      const flow = (fill.side === 'BUY' ? -gross : gross) - commission
      assert.equal(cents(fill.cashFlow), flow, 'CASH_FLOW_MISMATCH')
      if (fill.side === 'BUY') {
        assert.ok(fill.signalDate < date, 'BUY_BEFORE_SIGNAL_AVAILABLE')
        assert.ok(fill.quantity % 100 === 0 && !positions.has(fill.code), 'INVALID_BUY_POSITION')
        assert.ok(fill.stressedLossIncludingFees <= fill.riskBudget + 0.001, 'RISK_BUDGET_EXCEEDED')
        positions.set(fill.code, { quantity: fill.quantity, acquiredDate: date })
      } else {
        const position = positions.get(fill.code)
        assert.ok(position && position.quantity === fill.quantity, 'SELL_WITHOUT_EXACT_POSITION')
        assert.ok(!asset.tPlusOne || position.acquiredDate < date, 'T_PLUS_ONE')
        positions.delete(fill.code)
        attribution[fill.code].trades++
      }
      cash += flow
      fees += commission
      attribution[fill.code].cashFlowCents += flow
      attribution[fill.code].feesCents += commission
      assert.ok(cash >= 0, 'NEGATIVE_CASH')
    }
    for (const [code, position] of positions) {
      for (const div of byCode.get(code).dividends.filter(item => item.record_date === date)) {
        receivables.push({ code, amount: cents(position.quantity * div.div_cash),
          exDate: div.ex_date, payDate: div.pay_date, paid: false })
      }
    }
    let holdings = 0
    for (const [code, position] of positions) {
      holdings += byCode.get(code).byDate.get(date).close * position.quantity
    }
    const accrued = receivables.filter(claim => claim.exDate <= date && !claim.paid)
      .reduce((sum, claim) => sum + claim.amount, 0)
    const equity = (cash + cents(holdings) + accrued) / 100
    maxCashError = Math.max(maxCashError, Math.abs(row.cash - cash / 100))
    maxEquityError = Math.max(maxEquityError, Math.abs(row.equity - equity))
    near(row.cash, cash / 100, `CASH:${date}`)
    near(row.holdings, cents(holdings) / 100, `HOLDINGS:${date}`)
    near(row.receivable, accrued / 100, `RECEIVABLE:${date}`)
    near(row.equity, equity, `EQUITY:${date}`)
    assert.equal(row.positions, positions.size, 'POSITION_COUNT')
    observations++
  }
  near(run.fees, fees / 100, 'TOTAL_FEES')
  near(run.dividendsPaid, paid / 100, 'DIVIDENDS_PAID')
  const lastDate = run.curve.at(-1).date
  const contributions = {}
  for (const [code, item] of Object.entries(attribution)) {
    const position = positions.get(code)
    const marketValue = position ? position.quantity * byCode.get(code).byDate.get(lastDate).close : 0
    const accrued = receivables.filter(claim => claim.code === code && !claim.paid && claim.exDate <= lastDate)
      .reduce((sum, claim) => sum + claim.amount, 0)
    contributions[code] = {
      netPnl: (item.cashFlowCents + item.dividendCents + accrued + cents(marketValue)) / 100,
      dividends: (item.dividendCents + accrued) / 100,
      fees: item.feesCents / 100, trades: item.trades,
      endMarketValue: cents(marketValue) / 100,
    }
    assert.equal(position?.quantity || 0, run.openPositions[code]?.quantity || 0, 'END_POSITION')
  }
  const netPnl = Object.values(contributions).reduce((sum, item) => sum + item.netPnl, 0)
  near(netPnl, run.netPnl, 'ATTRIBUTION_SUM')
  near(spec.initialCash + netPnl, run.finalEquity, 'FINAL_EQUITY')
  return { state: 'PASS', observations, maxCashError, maxEquityError, contributions,
    checks: ['cash', 'fees', 'T+1', 'buy-lots', 'signals-before-fills', 'splits',
      'record-ex-pay-dividends', 'mark-to-market', 'asset-contribution-sum'],
    caveat: 'Independent accounting reconstruction, NOT independent price-source or fillability verification.' }
}
