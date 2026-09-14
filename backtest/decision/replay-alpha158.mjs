#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
  ACCOUNT_RISK_PROFILES,
} from '../../shared/accountRiskProfiles.js'
import {
  cancelDecisionOrder,
  createDecisionAccount,
  markDecisionAccount,
  processDecisionBar,
  submitDecisionOrder,
} from './accountEngine.mjs'
import {
  compactDecisionDate,
  loadDecisionDailyRows,
} from './replay-review-v3.mjs'
import {
  summarizeProfitabilityAccount,
} from './run-profitability-v2.mjs'

export const ALPHA158_ACCOUNT_REPLAY_VERSION =
  'alpha158-account-replay.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positionShares(state, code) {
  return (state.positions[code]?.layers || []).reduce(
    (sum, layer) => sum + layer.quantityShares,
    0,
  )
}

function positionValue(state, prices) {
  return Object.entries(state.positions).reduce(
    (sum, [code, position]) => {
      const price = finite(prices.get(code)?.close ?? position.lastPrice)
      return sum + (price > 0 ? price * positionShares(state, code) : 0)
    },
    0,
  )
}

function equityOf(state, prices) {
  return state.cashCents / 100 + positionValue(state, prices)
}

function processClose(state, date, dailyBar) {
  return processDecisionBar(state, {
    ...dailyBar,
    date,
    open: dailyBar.close,
  })
}

function scoreDates(rankings) {
  const result = new Map()
  for (const row of rankings) {
    const date = compactDecisionDate(row.date)
    if (!date) continue
    const values = result.get(date) || []
    values.push({
      code: String(row.code || ''),
      score: finite(row.score),
      rank: Math.trunc(finite(row.rank) || 0),
    })
    result.set(date, values)
  }
  for (const values of result.values()) {
    values.sort(
      (left, right) =>
        right.score - left.score || left.code.localeCompare(right.code),
    )
  }
  return result
}

function targetActions(state, ranking, { topk, nDrop }) {
  const held = Object.keys(state.positions)
  const score = new Map(
    ranking.map((row) => [row.code, row.score]),
  )
  const last = [...held].sort(
    (left, right) =>
      (score.get(right) ?? -Infinity)
      - (score.get(left) ?? -Infinity),
  )
  const heldSet = new Set(last)
  const today = ranking
    .filter((row) => !heldSet.has(row.code))
    .slice(0, nDrop + topk - last.length)
    .map((row) => row.code)
  const combined = [...new Set([...last, ...today])].sort(
    (left, right) =>
      (score.get(right) ?? -Infinity)
      - (score.get(left) ?? -Infinity),
  )
  const bottom = new Set(combined.slice(-nDrop))
  const sell = last.filter((code) => bottom.has(code))
  const buyCount = sell.length + topk - last.length
  return {
    sell,
    buy: today.slice(0, Math.max(0, buyCount)),
  }
}

function buyShares(state, price, prices, profile, buyCount) {
  const equity = equityOf(state, prices)
  const holdings = positionValue(state, prices)
  const cash = state.availableCashCents / 100
  const qlibAllocation = cash * 0.85 / Math.max(1, buyCount)
  const singleLimit = equity * profile.maximumSinglePositionPct / 100
  const positionCapacity = Math.max(
    0,
    equity * profile.maximumPositionPct / 100 - holdings,
  )
  const cashCapacity = Math.max(
    0,
    cash - equity * profile.minimumCashReservePct / 100,
  )
  const amount = Math.min(
    qlibAllocation,
    singleLimit,
    positionCapacity,
    cashCapacity,
  )
  return Math.max(0, Math.floor(amount / price / 100) * 100)
}

export function replayAlpha158Account({
  rankings,
  daily,
  dates,
  slippageBps = 5,
  topk = 5,
  nDrop = 1,
} = {}) {
  const profile = ACCOUNT_RISK_PROFILES.BASELINE
  const signals = scoreDates(rankings)
  const dateIndex = new Map(
    dates.map((date, index) => [date, index]),
  )
  const actions = new Map()
  for (const [signalDate, ranking] of signals) {
    const index = dateIndex.get(signalDate)
    const tradeDate = index == null ? null : dates[index + 1]
    if (tradeDate) actions.set(tradeDate, ranking)
  }
  let state = createDecisionAccount({
    initialCash: 100000,
    policy: { slippageBps },
  })
  const skipped = []
  for (const date of dates) {
    const prices = daily.byDate.get(date) || new Map()
    const ranking = actions.get(date)
    if (ranking?.length) {
      const target = targetActions(state, ranking, { topk, nDrop })
      for (const code of target.sell) {
        const dailyBar = daily.byCode.get(code)?.get(date)
        const shares = positionShares(state, code)
        if (!dailyBar || shares <= 0) continue
        const orderId = `alpha-sell:${date}:${code}`
        state = submitDecisionOrder(state, {
          orderId,
          code,
          security: { code, name: dailyBar.name },
          side: 'SELL',
          submittedDate: date,
          eligibleDate: date,
          quantityShares: shares,
          referencePrice: dailyBar.close,
          reason: 'ALPHA158_DROPOUT',
        })
        state = processClose(state, date, dailyBar)
        const order = state.orders.find((item) => item.orderId === orderId)
        if (order?.status !== 'FILLED') {
          state = cancelDecisionOrder(state, orderId, date)
          skipped.push({ date, code, side: 'SELL', reason: 'UNFILLED' })
        }
      }
      for (const code of target.buy) {
        if (state.positions[code]) continue
        const dailyBar = daily.byCode.get(code)?.get(date)
        if (!dailyBar) continue
        const shares = buyShares(
          state,
          dailyBar.close,
          prices,
          profile,
          target.buy.length,
        )
        if (shares < 100) {
          skipped.push({
            date,
            code,
            side: 'BUY',
            reason: 'ACCOUNT_CAPACITY',
          })
          continue
        }
        const orderId = `alpha-buy:${date}:${code}`
        state = submitDecisionOrder(state, {
          orderId,
          code,
          security: { code, name: dailyBar.name },
          side: 'BUY',
          submittedDate: date,
          eligibleDate: date,
          quantityShares: shares,
          referencePrice: dailyBar.close,
          reason: 'ALPHA158_TOPK',
        })
        state = processClose(state, date, dailyBar)
        const order = state.orders.find((item) => item.orderId === orderId)
        if (order?.status !== 'FILLED') {
          state = cancelDecisionOrder(state, orderId, date)
          skipped.push({ date, code, side: 'BUY', reason: 'UNFILLED' })
        }
      }
    }
    state = markDecisionAccount(state, {
      date,
      prices: Object.fromEntries(
        [...prices.entries()].map(([code, value]) => [
          code,
          value.close,
        ]),
      ),
    })
  }
  return {
    schemaVersion: ALPHA158_ACCOUNT_REPLAY_VERSION,
    topk,
    nDrop,
    skipped,
    accountState: state,
    summary: summarizeProfitabilityAccount(state),
  }
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1]
  }
  if (!values['--scores'] || !values['--daily']) {
    throw new Error(
      'usage: replay-alpha158.mjs --scores file --daily file [--output file]',
    )
  }
  return values
}

function main() {
  const args = parseArguments(process.argv.slice(2))
  const scorePayload = JSON.parse(
    fs.readFileSync(args['--scores'], 'utf8'),
  )
  const topk = Math.max(
    1,
    Math.trunc(finite(args['--topk']) || 5),
  )
  const nDrop = Math.max(
    1,
    Math.min(topk, Math.trunc(finite(args['--n-drop']) || 1)),
  )
  const rankings = scorePayload.rankings || []
  const codes = new Set(rankings.map((row) => row.code))
  const daily = loadDecisionDailyRows(
    args['--daily'],
    codes,
    { adjustPrices: true },
  )
  const lower = compactDecisionDate(
    scorePayload.folds?.[0]?.trainStartDate,
  )
  const upper = [...daily.byDate.keys()].sort().at(-1)
  const dates = [...daily.byDate.keys()]
    .filter((date) => date >= lower && date <= upper)
    .sort()
  const scenarios = {
    primary: replayAlpha158Account({
      rankings,
      daily,
      dates,
      slippageBps: 5,
      topk,
      nDrop,
    }),
    doubleSlippage: replayAlpha158Account({
      rankings,
      daily,
      dates,
      slippageBps: 10,
      topk,
      nDrop,
    }),
  }
  const result = {
    schemaVersion: ALPHA158_ACCOUNT_REPLAY_VERSION,
    generatedAt: Date.now(),
    sourceScores: path.resolve(args['--scores']),
    dateRange: { from: dates[0], to: dates.at(-1) },
    scenarios,
  }
  if (args['--output']) {
    fs.writeFileSync(
      args['--output'],
      JSON.stringify(result, null, 2),
    )
  }
  console.log(JSON.stringify({
    output: args['--output']
      ? path.resolve(args['--output'])
      : null,
    scenarios: Object.fromEntries(
      Object.entries(scenarios).map(([name, value]) => [
        name,
        {
          ...value.summary,
          accountState: undefined,
        },
      ]),
    ),
  }, null, 2))
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main()
}
