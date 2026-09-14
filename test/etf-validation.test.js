import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { prepareHistory } from '../backtest/etf/data.mjs'
import { runPortfolio } from '../backtest/etf/engine.mjs'
import { auditLedger } from '../backtest/etf/ledger-audit.mjs'

function fixture({ split = false } = {}) {
  const spec = JSON.parse(fs.readFileSync(new URL('../backtest/etf/experiment.json', import.meta.url)))
  Object.assign(spec, { start: '20250102', end: '20250207',
    assets: [spec.assets[0]], staticCodes: [spec.assets[0].code] })
  const calendar = []
  for (let t = Date.UTC(2023, 0, 2); t <= Date.UTC(2025, 1, 7); t += 86400000) {
    const d = new Date(t)
    if (d.getUTCDay() % 6) calendar.push(d.toISOString().slice(0, 10).replaceAll('-', ''))
  }
  const code = spec.assets[0].code
  const source = { code, basic: { list_date: '20120101' }, dividends: [],
    daily: calendar.map((date, i) => {
      const factor = split && date >= '20250106' ? 2 : 1
      return { trade_date: date, open: (10 + i * 0.01) / factor, close: (10 + i * 0.01) / factor,
        high: (10.02 + i * 0.01) / factor, low: (9.98 + i * 0.01) / factor,
        pre_close: (9.99 + i * 0.01) / factor, vol: 100000, amount: 100000 }
    }),
    adj: calendar.map(date => ({ trade_date: date, adj_factor: split && date >= '20250106' ? 2 : 1 })) }
  const actions = split ? { [code]: { splits: [{
    priceDate: '20250106', recordDate: '20250103', ratio: 2, rounding: 'ceil', source: 'synthetic',
  }] } } : {}
  return { spec, history: { calendar, assets: [source] }, actions }
}

test('a later split cannot mutate the earlier signal snapshot', () => {
  const { spec, history, actions } = fixture({ split: true })
  const data = prepareHistory(history, spec, actions)
  const full = runPortfolio({ ...data, spec, model: 'weekly_rotation', slippageBps: 5 })
  const prefix = runPortfolio({ ...data, spec: { ...spec, end: '20250103' },
    model: 'weekly_rotation', slippageBps: 5 })
  assert.deepEqual(full.signals.filter(row => row.date <= '20250103'), prefix.signals)
})

test('accounting reconstruction detects cash, fee, position and attribution corruption', () => {
  const { spec, history, actions } = fixture({ split: true })
  const data = { ...prepareHistory(history, spec, actions), spec }
  const result = runPortfolio({ ...data, model: 'buy_hold_reference', slippageBps: 5 })
  assert.equal(auditLedger(result, data).maxEquityError, 0)
  for (const corrupt of [
    run => { run.curve[1].cash += 1 },
    run => { run.fills[0].fees.total += 1 },
    run => { run.openPositions[spec.assets[0].code].quantity -= 1 },
    run => { run.netPnl += 1 },
    run => { run.fills[0].signalDate = run.fills[0].date },
  ]) {
    const copy = structuredClone(result)
    corrupt(copy)
    assert.throws(() => auditLedger(copy, data))
  }
})

test('latency stress never sells at an earlier intraday stop after learning daily low', () => {
  const { spec, history, actions } = fixture()
  const code = spec.assets[0].code
  // A T+0 security separates observation delay from the T+1 lock.
  spec.assets[0].tPlusOne = false
  const day = history.assets[0].daily.find(row => row.trade_date === '20250103')
  day.low = day.open * 0.97
  const later = history.assets[0].daily.find(row => row.trade_date === '20250106')
  later.open *= 0.98
  later.low = later.open
  const data = { ...prepareHistory(history, spec, actions), spec }
  const original = runPortfolio({ ...data, model: 'static_risk_matched', slippageBps: 10 })
  const delayed = runPortfolio({ ...data, model: 'static_risk_matched',
    slippageBps: 10, stopExecution: 'NEXT_OPEN' })
  assert.equal(original.trades[0].exitDate, '20250103')
  assert.equal(delayed.trades[0].exitDate, '20250106')
  const sell = delayed.fills.find(fill => fill.side === 'SELL' && fill.code === code)
  assert.ok(sell.fillPrice < later.open)
  assert.equal(auditLedger(delayed, data).state, 'PASS')
  assert.throws(() => runPortfolio({ ...data, model: 'cash',
    slippageBps: 10, stopExecution: 'UNKNOWN' }), /UNKNOWN_STOP_EXECUTION/)
})
