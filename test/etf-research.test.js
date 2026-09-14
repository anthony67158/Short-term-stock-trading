import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { etfFill, validateStockOrder } from '../backtest/etf/execution.mjs'
import { prepareHistory, featuresAt } from '../backtest/etf/data.mjs'
import { runPortfolio, selectTargets } from '../backtest/etf/engine.mjs'
import { replayArbitration } from '../backtest/audit-current-chain.mjs'

const originalSpec = JSON.parse(fs.readFileSync(new URL('../backtest/etf/experiment.json', import.meta.url)))
function fixture() {
  const calendar = []
  for (let at = Date.UTC(2023, 0, 2); at <= Date.UTC(2025, 2, 7); at += 86400000) {
    const day = new Date(at)
    if (day.getUTCDay() % 6 !== 0) calendar.push(day.toISOString().slice(0, 10).replaceAll('-', ''))
  }
  const spec = { ...originalSpec, start: '20250102', end: '20250307',
    assets: [originalSpec.assets[0]], staticCodes: ['510300.SH'] }
  const asset = {
    ...spec.assets[0], basic: { list_date: '20120101' }, dividends: [],
    daily: calendar.map((date, i) => ({
      trade_date: date, open: 10 + i * 0.01, close: 10 + i * 0.01,
      high: 10.01 + i * 0.01, low: 9.99 + i * 0.01,
      pre_close: i ? 10 + (i - 1) * 0.01 : 10,
      vol: 100000, amount: 100000,
    })),
    adj: calendar.map(date => ({ trade_date: date, adj_factor: 1 })),
  }
  return { spec, history: { calendar, assets: [asset] } }
}

test('research stock audit requires explicit board permissions and STAR minimum', () => {
  assert.equal(validateStockOrder({ code: '688150', quantity: 100, permissions: { star: true } }), 'STAR_MINIMUM_200')
  assert.equal(validateStockOrder({ code: '688150', quantity: 201, permissions: { star: true } }), null)
  assert.equal(validateStockOrder({ code: '688150', quantity: 200 }), 'STAR_PERMISSION_REQUIRED')
})

test('ETF execution uses adverse tick rounding and no stock taxes', () => {
  const base = { price: 4.5, preClose: 4.5, quantity: 100, spec: originalSpec,
    asset: originalSpec.assets[0], slippageBps: 5 }
  const buy = etfFill({ ...base, side: 'BUY' }), sell = etfFill({ ...base, side: 'SELL' })
  assert.equal(buy.fillPrice, 4.503)
  assert.equal(sell.fillPrice, 4.497)
  assert.equal(sell.fees.stampDuty, 0)
  assert.equal(sell.fees.transfer, 0)
  assert.equal(buy.fees.total, 5)
  assert.equal(etfFill({ ...base, side: 'BUY', price: 4.95 }).fillable, false)
  assert.throws(() => etfFill({ ...base, side: 'BUY', price: NaN }))
})

test('production arbitration replays original contract and fails closed without a model', () => {
  assert.throws(() => replayArbitration({}), /ENVELOPE/)
  const actual = replayArbitration({ stateInput: {
    code: '600000', asOf: 1000, account: { complete: true },
    evidence: { complete: true }, model: { ready: false },
    quote: { live: true, price: 10 },
  }, plans: [] })
  assert.equal(actual.action, 'WAIT')
  assert.equal(actual.reason, 'MODEL_UNAVAILABLE')
})

test('history fails closed for missing sessions, factors and unaccounted splits', () => {
  for (const corrupt of [
    history => history.assets[0].daily.splice(300, 1),
    history => history.assets[0].adj.splice(300, 1),
    history => { history.assets[0].adj[300].adj_factor = 2 },
  ]) {
    const { spec, history } = fixture()
    corrupt(history)
    assert.throws(() => prepareHistory(history, spec))
  }
})

test('future bars cannot change historical features or selected targets', () => {
  const { spec, history } = fixture()
  const before = prepareHistory(history, spec)
  for (const row of history.assets[0].daily.filter(row => row.trade_date > spec.start)) {
    for (const key of ['open', 'close', 'high', 'low', 'pre_close']) row[key] *= 2
  }
  const after = prepareHistory(history, spec)
  assert.deepEqual(featuresAt(before.assets[0], spec.start, spec), featuresAt(after.assets[0], spec.start, spec))
  assert.deepEqual(selectTargets(before.assets, spec.start, spec, 'weekly_rotation').map(x => x.feature),
    selectTargets(after.assets, spec.start, spec, 'weekly_rotation').map(x => x.feature))
})

test('ETF portfolio conserves cash and trades strictly after the signal date', () => {
  const { spec, history } = fixture()
  const result = runPortfolio({ ...prepareHistory(history, spec), spec, model: 'monthly_trend', slippageBps: 5 })
  assert.ok(result.fills.some(row => row.side === 'BUY'))
  assert.ok(result.fills.filter(row => row.side === 'BUY').every(row => row.date > row.signalDate))
  assert.ok(result.fills.filter(row => row.side === 'BUY')
    .every(row => row.stressedLossIncludingFees <= row.riskBudget))
  assert.ok(result.curve.every(row => row.cash >= 0))
  const cash = spec.initialCash + result.fills.reduce((sum, row) => sum + row.cashFlow, 0) + result.dividendsPaid
  assert.ok(Math.abs(cash - result.curve.at(-1).cash) < 0.01)
  const cashOnly = runPortfolio({ ...prepareHistory(history, spec), spec, model: 'cash', slippageBps: 10 })
  assert.equal(cashOnly.finalEquity, spec.initialCash)
})

test('dividend belongs to record-date holders, is receivable ex-date and cash only on payment', () => {
  const { spec, history } = fixture()
  const asset = history.assets[0], ex = '20250115', pay = '20250120'
  asset.dividends = [{ ann_date: '20250103', record_date: '20250114', ex_date: ex,
    pay_date: pay, div_cash: 0.1, div_proc: '实施' }]
  for (const row of asset.daily.filter(row => row.trade_date >= ex)) {
    for (const key of ['open', 'high', 'low', 'close', 'pre_close']) row[key] -= 0.1
  }
  const prepared = prepareHistory(history, spec)
  const result = runPortfolio({ ...prepared, spec, model: 'static_risk_matched', slippageBps: 5 })
  const day = date => result.curve.find(row => row.date === date)
  assert.equal(day('20250114').receivable, 0)
  assert.ok(day(ex).receivable > 0)
  assert.equal(day(ex).cash, day('20250114').cash)
  assert.equal(day(pay).receivable, 0)
  assert.ok(day(pay).cash > day(ex).cash)
})

test('T+1 locks entry-day stop and executes pending stop only on a later session', () => {
  const { spec, history } = fixture()
  const row = history.assets[0].daily.find(item => item.trade_date === '20250103')
  row.low = row.open * 0.98
  const result = runPortfolio({ ...prepareHistory(history, spec), spec, model: 'static_risk_matched', slippageBps: 5 })
  assert.ok(result.events.some(event => event.date === '20250103' && event.reason === 'T_PLUS_ONE_LOCKED'))
  assert.equal(result.trades[0].exitDate, '20250106')
  assert.ok(result.fills.filter(fill => fill.side === 'SELL').every(fill => fill.date !== '20250103'))
})

test('split changes units and stops without inventing a cash return', () => {
  const { spec, history } = fixture()
  const splitDate = '20250115', ratio = 1.14539
  const asset = history.assets[0]
  for (const row of asset.daily.filter(item => item.trade_date >= splitDate)) {
    for (const key of ['open', 'high', 'low', 'close', 'pre_close']) row[key] /= ratio
  }
  for (const row of asset.adj.filter(item => item.trade_date >= splitDate)) row.adj_factor = ratio
  const actions = { '510300.SH': { splits: [{
    priceDate: splitDate, ratio, rounding: 'ceil', source: 'test-fixture',
  }] } }
  const result = runPortfolio({ ...prepareHistory(history, spec, actions), spec,
    model: 'buy_hold_reference', slippageBps: 5 })
  const buy = result.fills.find(row => row.side === 'BUY')
  assert.equal(result.openPositions['510300.SH'].quantity, Math.ceil(buy.quantity * ratio))
  assert.equal(result.fills.length, 1)
  const before = result.curve.find(row => row.date === '20250114')
  const after = result.curve.find(row => row.date === splitDate)
  assert.ok(Math.abs(after.equity - before.equity) < 100)
  assert.equal(etfFill({ side: 'SELL', quantity: 201, price: 5, preClose: 5,
    asset: spec.assets[0], spec, slippageBps: 5 }).fillable, true)
})

test('a limit-down opening cannot release cash until a real later sell', () => {
  const { spec, history } = fixture()
  const asset = history.assets[0]
  const row = asset.daily.find(item => item.trade_date === '20250106')
  row.open = Math.round(row.pre_close * 0.9 * 1000) / 1000
  row.close = row.open
  row.high = row.open
  row.low = row.open
  const result = runPortfolio({ ...prepareHistory(history, spec), spec,
    model: 'static_risk_matched', slippageBps: 5 })
  assert.ok(result.events.some(event => event.date === '20250106' && event.reason === 'PRICE_LIMIT'))
  assert.equal(result.fills.filter(row => row.side === 'SELL' && row.date === '20250106').length, 0)
  assert.equal(result.trades[0].exitDate, '20250107')
})

test('production arbitration does not upgrade SHADOW scores to DIRECT', () => {
  const plan = { route: 'IMMEDIATE', entryPlan: { price: 10 },
    exitPlan: { hardStopPrice: 9, takeProfitPrice: 12 },
    opportunityScore: { state: 'READY', usagePolicy: 'SHADOW', serverVerified: true,
      pFill: 1, pWinGivenFill: 0.9, expectedNetR: 1, netRLowerBound: 0.5,
      expectedShortfall10: -0.5, modelVersion: 'test' } }
  const result = replayArbitration({ stateInput: {
    code: '600000', asOf: 1000, quote: { live: true, price: 10 },
    account: { complete: true }, evidence: { complete: true }, model: { ready: true },
    paths: [plan],
  }, plans: [plan] })
  assert.equal(result.action, 'WAIT')
})
