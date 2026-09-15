import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterReviewSelectionByAlpha,
  replayReviewAccount,
} from '../backtest/decision/replay-review-v3.mjs'

function dailyBar(date, close, previousClose = close, code = '600001') {
  return {
    date,
    code,
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
  assert.ok(
    result.riskEvidence.maximumOpenRiskPct <= 5,
    `maximumOpenRiskPct=${result.riskEvidence.maximumOpenRiskPct}`,
  )
  assert.equal(
    result.riskProfileVersion,
    'account-risk-profiles.v1',
  )
  assert.equal(result.summary.audit.ok, true)
  assert.equal(result.accountState.positions['600001'], undefined)
})

test('V3账户回放限制同日累计开放风险', () => {
  const dates = ['20260101', '20260102', '20260105']
  const codes = Array.from(
    { length: 10 },
    (_, index) => `6000${String(index + 1).padStart(2, '0')}`,
  )
  const bars = dates.flatMap((date, dateIndex) =>
    codes.map((code) => dailyBar(
      date,
      dateIndex === 2 ? 11 : 10,
      dateIndex === 0 ? 9.9 : 10,
      code,
    )))
  const byDate = new Map(dates.map((date) => [
    date,
    new Map(
      bars
        .filter((bar) => bar.date === date)
        .map((bar) => [bar.code, bar]),
    ),
  ]))
  const byCode = new Map(codes.map((code) => [
    code,
    new Map(
      bars
        .filter((bar) => bar.code === code)
        .map((bar) => [bar.date, bar]),
    ),
  ]))
  const selected = codes.map((code, index) => ({
    fold: 1,
    date: '2026-01-01',
    decisionId: `decision-${index}`,
    code,
    score: 100 - index,
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
  }))

  const result = replayReviewAccount({
    selected,
    daily: { byDate, byCode },
    dates,
  })

  assert.ok(
    result.riskEvidence.maximumOpenRiskPct <= 5,
    `maximumOpenRiskPct=${result.riskEvidence.maximumOpenRiskPct}`,
  )
  assert.ok(result.acceptedCount < selected.length)
  assert.ok(result.skipped.some(
    (item) => item.reason === 'ACCOUNT_CAPACITY',
  ))
})

test('Alpha158候选过滤按信号日和排名收紧V3事件', () => {
  const selected = [
    { date: '2026-01-01', code: '600001' },
    { date: '2026-01-01', code: '600002' },
    { date: '2026-01-02', code: '600001' },
  ]
  const alpha = {
    rankings: [
      { date: '20260101', code: '600001', rank: 20 },
      { date: '20260101', code: '600002', rank: 60 },
      { date: '20260102', code: '600001', rank: 51 },
      { date: '20260102', code: '600001', rank: null },
    ],
  }

  assert.deepEqual(
    filterReviewSelectionByAlpha(selected, alpha, 50),
    [{ date: '2026-01-01', code: '600001' }],
  )
})
