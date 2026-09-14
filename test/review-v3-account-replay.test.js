import test from 'node:test'
import assert from 'node:assert/strict'

import {
  replayReviewAccount,
} from '../backtest/decision/replay-review-v3.mjs'

function dailyBar(date, close, previousClose = close) {
  return {
    date,
    code: '600001',
    name: '主板样本',
    open: close,
    high: close,
    low: close,
    close,
    previousClose,
    volume: 100000,
  }
}

test('V3账户回放按风险预算执行并通过独立分币审计', () => {
  const dates = ['20260101', '20260102', '20260105']
  const bars = [
    dailyBar('20260101', 10, 9.9),
    dailyBar('20260102', 10, 10),
    dailyBar('20260105', 11, 10),
  ]
  const byDate = new Map(
    bars.map((bar) => [bar.date, new Map([[bar.code, bar]])]),
  )
  const byCode = new Map([[
    '600001',
    new Map(bars.map((bar) => [bar.date, bar])),
  ]])
  const selected = [{
    fold: 1,
    date: '2026-01-01',
    decisionId: 'decision-1',
    code: '600001',
    score: 1,
    outcome: {
      fillStatus: 'FILLED',
      reviewScoreInput: {
        priceContract: {
          entryPriceMilliCny: 10000,
          stopPriceMilliCny: 9000,
        },
      },
      entry: {
        tradeDate: '20260102',
        referencePrice: 10,
      },
      exit: {
        tradeDate: '20260105',
        referencePrice: 11,
      },
    },
  }]

  const result = replayReviewAccount({
    selected,
    daily: { byDate, byCode },
    dates,
  })

  assert.equal(result.acceptedCount, 1)
  assert.equal(result.summary.closedTradeCount, 1)
  assert.ok(result.summary.returnPct > 0)
  assert.ok(result.riskEvidence.maximumSingleTradeRiskPct <= 0.6)
  assert.equal(result.summary.audit.ok, true)
  assert.equal(result.accountState.positions['600001'], undefined)
})
