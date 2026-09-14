import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { prepareHistory } from '../backtest/etf/data.mjs'
import { runPortfolio } from '../backtest/etf/engine.mjs'

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
