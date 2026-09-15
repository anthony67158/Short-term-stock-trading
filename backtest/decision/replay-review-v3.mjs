#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import {
  ACCOUNT_RISK_PROFILES,
  ACCOUNT_RISK_PROFILE_VERSION,
} from '../../shared/accountRiskProfiles.js'
import {
  cancelDecisionOrder,
  createDecisionAccount,
  markDecisionAccount,
  processDecisionBar,
  submitDecisionOrder,
} from './accountEngine.mjs'
import {
  summarizeProfitabilityAccount,
} from './run-profitability-v2.mjs'

export const REVIEW_V3_ACCOUNT_REPLAY_VERSION =
  'review-v3-account-replay.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function compactDecisionDate(value) {
  const match = String(value || '').match(
    /^(\d{4})-?(\d{2})-?(\d{2})/,
  )
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

function beijingDate(timestamp) {
  const value = finite(timestamp)
  if (!(value > 0)) return null
  return new Date(value + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')
}

export function filterReviewSelectionByAlpha(
  selected,
  alphaPayload,
  topN = 50,
) {
  const allowed = new Map()
  for (const row of alphaPayload?.rankings || []) {
    const rank = Math.trunc(finite(row.rank) || 0)
    const code = String(row.code || '')
    if (rank < 1 || rank > topN || !code) continue
    const date = compactDecisionDate(row.date)
    if (!date) continue
    const codes = allowed.get(date) || new Set()
    codes.add(code)
    allowed.set(date, codes)
  }
  return (Array.isArray(selected) ? selected : []).filter((row) => {
    const date = compactDecisionDate(row.date)
    return allowed.get(date)?.has(String(row.code || '')) === true
  })
}

export function loadDecisionDailyRows(
  file,
  codes,
  { adjustPrices = false } = {},
) {
  const payload = JSON.parse(
    gunzipSync(fs.readFileSync(file)).toString('utf8'),
  )
  const rows = []
  for (const row of payload) {
    const code = String(row?.code || '')
    const date = compactDecisionDate(row?.date)
    if (!codes.has(code) || !date) continue
    const normalized = {
      date,
      code,
      name: String(row.name || code),
      open: finite(row.open),
      high: finite(row.high),
      low: finite(row.low),
      close: finite(row.close),
      previousClose: finite(row.preClose ?? row.pre_close),
      volume: Math.max(0, finite(row.volume) || 0),
    }
    if (
      !(normalized.open > 0)
      || !(normalized.low > 0)
      || !(normalized.close > 0)
      || !(normalized.previousClose > 0)
    ) continue
    rows.push(normalized)
  }
  if (adjustPrices) {
    const grouped = new Map()
    for (const row of rows) {
      const values = grouped.get(row.code) || []
      values.push(row)
      grouped.set(row.code, values)
    }
    for (const values of grouped.values()) {
      values.sort((left, right) => left.date.localeCompare(right.date))
      let previousAdjustedClose = null
      for (const row of values) {
        const scale = previousAdjustedClose == null
          ? 1
          : previousAdjustedClose / row.previousClose
        for (const name of ['open', 'high', 'low', 'close']) {
          row[name] *= scale
        }
        row.previousClose = previousAdjustedClose ?? row.previousClose
        previousAdjustedClose = row.close
      }
    }
  }
  const byDate = new Map()
  const byCode = new Map()
  for (const normalized of rows) {
    const { code, date } = normalized
    if (!byDate.has(date)) byDate.set(date, new Map())
    byDate.get(date).set(code, normalized)
    if (!byCode.has(code)) byCode.set(code, new Map())
    byCode.get(code).set(date, normalized)
  }
  return { byDate, byCode }
}

function actionsByDate(rows, tradingDates, nextOpen) {
  const result = new Map()
  const add = (date, type, row) => {
    if (!date) return
    const actions = result.get(date) || []
    actions.push({ type, row })
    result.set(date, actions)
  }
  const nextDate = (date) => {
    const index = tradingDates.indexOf(date)
    return index >= 0 ? tradingDates[index + 1] : null
  }
  for (const row of rows) {
    const outcome = row.outcome || {}
    const signalDate = compactDecisionDate(row.date)
    add(signalDate, 'SIGNAL', row)
    if (outcome.fillStatus === 'FILLED') {
      const entryDate = compactDecisionDate(outcome.entry?.tradeDate)
      const rawExitDate = compactDecisionDate(outcome.exit?.tradeDate)
      add(entryDate, 'ENTRY', row)
      add(
        nextOpen ? nextDate(rawExitDate) : rawExitDate,
        'EXIT',
        row,
      )
    } else {
      const terminalDate =
        compactDecisionDate(outcome.entry?.date)
        || beijingDate(outcome.evaluatedAt)
        || signalDate
      add(terminalDate, 'CANCEL', row)
    }
  }
  return result
}

function positionValue(state, prices) {
  let total = 0
  for (const [code, position] of Object.entries(state.positions)) {
    const price = finite(prices.get(code)?.close ?? position.lastPrice)
    const shares = position.layers.reduce(
      (sum, layer) => sum + layer.quantityShares,
      0,
    )
    if (price > 0) total += price * shares
  }
  return total
}

function pendingNotional(state) {
  return state.orders
    .filter((order) => (
      order.side === 'BUY'
      && ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)
    ))
    .reduce(
      (sum, order) =>
        sum + order.referencePrice * order.remainingShares,
      0,
    )
}

function equityOf(state, prices) {
  return state.cashCents / 100 + positionValue(state, prices)
}

function plannedPrices(row) {
  const contract = row.outcome?.reviewScoreInput?.priceContract
  const entry = finite(contract?.entryPriceMilliCny) / 1000
  const stop = finite(contract?.stopPriceMilliCny) / 1000
  return entry > stop && stop > 0 ? { entry, stop } : null
}

function sharesForSignal(
  state,
  row,
  prices,
  profile,
  currentOpenRiskCash = 0,
) {
  const planned = plannedPrices(row)
  if (!planned) return 0
  const equity = equityOf(state, prices)
  const holdings = positionValue(state, prices)
  const reserved = pendingNotional(state)
  const riskPerShare = planned.entry - planned.stop
  const riskShares = Math.floor(
    equity * profile.singleTradeRiskPct / 100
      / riskPerShare
      / 100,
  ) * 100
  const openRiskCapacity = Math.max(
    0,
    equity * profile.maximumOpenRiskPct / 100
      - currentOpenRiskCash,
  )
  const openRiskShares = Math.floor(
    openRiskCapacity / riskPerShare / 100,
  ) * 100
  const singleShares = Math.floor(
    equity * profile.maximumSinglePositionPct / 100
      / planned.entry
      / 100,
  ) * 100
  const positionCapacity = Math.max(
    0,
    equity * profile.maximumPositionPct / 100
      - holdings
      - reserved,
  )
  const positionShares = Math.floor(
    positionCapacity / planned.entry / 100,
  ) * 100
  const cashCapacity = Math.max(
    0,
    state.availableCashCents / 100
      - equity * profile.minimumCashReservePct / 100,
  )
  const cashShares = Math.floor(
    cashCapacity / planned.entry / 100,
  ) * 100
  return Math.max(
    0,
    Math.min(
      riskShares,
      openRiskShares,
      singleShares,
      positionShares,
      cashShares,
    ),
  )
}

function hasOpenExposure(state, code) {
  if (state.positions[code]) return true
  return state.orders.some((order) => (
    order.code === code
    && order.side === 'BUY'
    && ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)
  ))
}

function orderId(kind, row) {
  return `${kind}:${row.fold}:${row.decisionId}`
}

function processAtReference(state, date, referencePrice, daily) {
  if (!daily || !(referencePrice > 0)) return state
  return processDecisionBar(state, {
    ...daily,
    date,
    open: referencePrice,
  })
}

export function replayReviewAccount({
  selected,
  daily,
  dates,
  slippageBps = 5,
  stopExecution = 'INTRADAY_STOP',
  riskProfile = 'BASELINE',
} = {}) {
  const profile = ACCOUNT_RISK_PROFILES[riskProfile]
  if (!profile) throw new Error('INVALID_RISK_PROFILE')
  const nextOpen = stopExecution === 'NEXT_OPEN'
  const actions = actionsByDate(selected, dates, nextOpen)
  let state = createDecisionAccount({
    initialCash: 100000,
    policy: { slippageBps, stopExecution },
  })
  const accepted = new Set()
  const skipped = []
  let maximumSingleTradeRiskPct = 0
  let maximumOpenRiskPct = 0
  let maximumObservedOpenRiskPct = 0
  const openRisk = new Map()

  for (const date of dates) {
    const prices = daily.byDate.get(date) || new Map()
    const rows = actions.get(date) || []
    const exits = rows.filter((item) => item.type === 'EXIT')
    const signals = rows
      .filter((item) => item.type === 'SIGNAL')
      .sort((left, right) => right.row.score - left.row.score)
    const entries = rows.filter((item) => item.type === 'ENTRY')
    const cancels = rows.filter((item) => item.type === 'CANCEL')

    for (const item of exits) {
      const row = item.row
      if (!accepted.has(row.decisionId)) continue
      const code = row.code
      const position = state.positions[code]
      if (!position) {
        if (!hasOpenExposure(state, code)) openRisk.delete(code)
        continue
      }
      const quantityShares = position.layers.reduce(
        (sum, layer) => sum + layer.quantityShares,
        0,
      )
      const dailyBar = daily.byCode.get(code)?.get(date)
      const referencePrice = nextOpen
        ? dailyBar?.open
        : finite(row.outcome?.exit?.referencePrice)
      state = submitDecisionOrder(state, {
        orderId: orderId('sell', row),
        code,
        security: { code, name: dailyBar?.name || code },
        side: 'SELL',
        submittedDate: date,
        eligibleDate: date,
        quantityShares,
        referencePrice,
        reason: nextOpen ? 'NEXT_OPEN_EXIT' : 'MODEL_EXIT',
      })
      state = processAtReference(
        state,
        date,
        referencePrice,
        dailyBar,
      )
      if (!state.positions[code]) openRisk.delete(code)
    }

    for (const item of signals) {
      const row = item.row
      const code = row.code
      if (hasOpenExposure(state, code)) {
        skipped.push({
          decisionId: row.decisionId,
          reason: 'DUPLICATE_OPEN_EXPOSURE',
        })
        continue
      }
      const quantityShares = sharesForSignal(
        state,
        row,
        prices,
        profile,
        [...openRisk.values()].reduce(
          (sum, item) => sum + item.riskCash,
          0,
        ),
      )
      if (quantityShares < 100) {
        skipped.push({
          decisionId: row.decisionId,
          reason: 'ACCOUNT_CAPACITY',
        })
        continue
      }
      const planned = plannedPrices(row)
      const entryDate =
        compactDecisionDate(row.outcome?.entry?.tradeDate)
        || compactDecisionDate(row.outcome?.entry?.date)
        || date
      try {
        state = submitDecisionOrder(state, {
          orderId: orderId('buy', row),
          code,
          security: {
            code,
            name: String(
              daily.byCode.get(code)?.get(date)?.name || code,
            ),
          },
          side: 'BUY',
          submittedDate: date,
          eligibleDate: entryDate,
          quantityShares,
          referencePrice: planned.entry,
          reason: 'REVIEW_V3_SELECTED',
        })
      } catch (error) {
        skipped.push({
          decisionId: row.decisionId,
          reason: String(error?.message || error),
        })
        continue
      }
      accepted.add(row.decisionId)
      const riskPct = (
        (planned.entry - planned.stop)
        * quantityShares
        / Math.max(1, equityOf(state, prices))
        * 100
      )
      maximumSingleTradeRiskPct = Math.max(
        maximumSingleTradeRiskPct,
        riskPct,
      )
      openRisk.set(code, {
        riskCash:
          (planned.entry - planned.stop) * quantityShares,
      })
      maximumOpenRiskPct = Math.max(
        maximumOpenRiskPct,
        [...openRisk.values()].reduce(
          (sum, item) => sum + item.riskCash,
          0,
        ) / Math.max(1, equityOf(state, prices)) * 100,
      )
    }

    for (const item of entries) {
      const row = item.row
      if (!accepted.has(row.decisionId)) continue
      const dailyBar = daily.byCode.get(row.code)?.get(date)
      state = processAtReference(
        state,
        date,
        finite(row.outcome?.entry?.referencePrice),
        dailyBar,
      )
    }

    for (const item of cancels) {
      if (!accepted.has(item.row.decisionId)) continue
      state = cancelDecisionOrder(
        state,
        orderId('buy', item.row),
        date,
      )
      if (!hasOpenExposure(state, item.row.code)) {
        openRisk.delete(item.row.code)
      }
    }

    const equity = equityOf(state, prices)
    maximumObservedOpenRiskPct = Math.max(
      maximumObservedOpenRiskPct,
      [...openRisk.values()].reduce(
        (sum, item) => sum + item.riskCash,
        0,
      ) / Math.max(1, equity) * 100,
    )
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
    schemaVersion: REVIEW_V3_ACCOUNT_REPLAY_VERSION,
    riskProfileVersion: ACCOUNT_RISK_PROFILE_VERSION,
    riskProfile,
    riskEvidence: {
      maximumSingleTradeRiskPct,
      maximumOpenRiskPct,
      maximumObservedOpenRiskPct,
    },
    acceptedCount: accepted.size,
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
  if (!values['--selection'] || !values['--daily']) {
    throw new Error(
      'usage: replay-review-v3.mjs --selection file --daily file [--output file]',
    )
  }
  return values
}

function main() {
  const args = parseArguments(process.argv.slice(2))
  const selection = JSON.parse(
    fs.readFileSync(args['--selection'], 'utf8'),
  )
  const rawSelected = selection.selected || []
  const alphaPayload = args['--alpha-scores']
    ? JSON.parse(fs.readFileSync(args['--alpha-scores'], 'utf8'))
    : null
  const alphaTopN = Math.max(
    1,
    Math.trunc(finite(args['--alpha-top-n']) || 50),
  )
  const selected = alphaPayload
    ? filterReviewSelectionByAlpha(
        rawSelected,
        alphaPayload,
        alphaTopN,
      )
    : rawSelected
  const riskProfile = String(
    args['--risk-profile'] || 'BASELINE',
  ).toUpperCase()
  const codes = new Set(selected.map((row) => row.code))
  const daily = loadDecisionDailyRows(args['--daily'], codes)
  const signalDates = [...new Set(
    selected.map((row) => compactDecisionDate(row.date)),
  )]
  const lower = compactDecisionDate(
    selection.source?.reports?.[0]?.ranges
      ?.opportunity?.trainStartDate,
  ) || signalDates.sort()[0]
  const upper = [...daily.byDate.keys()].sort().at(-1)
  const dates = [...daily.byDate.keys()]
    .filter((date) => date >= lower && date <= upper)
    .sort()
  const scenarios = {
    primary: replayReviewAccount({
      selected,
      daily,
      dates,
      slippageBps: 5,
      riskProfile,
    }),
    doubleSlippage: replayReviewAccount({
      selected,
      daily,
      dates,
      slippageBps: 10,
      riskProfile,
    }),
    nextOpen: replayReviewAccount({
      selected,
      daily,
      dates,
      slippageBps: 5,
      stopExecution: 'NEXT_OPEN',
      riskProfile,
    }),
  }
  const result = {
    schemaVersion: REVIEW_V3_ACCOUNT_REPLAY_VERSION,
    generatedAt: Date.now(),
    sourceSelection: path.resolve(args['--selection']),
    alphaFilter: alphaPayload ? {
      source: path.resolve(args['--alpha-scores']),
      topN: alphaTopN,
      inputCandidates: rawSelected.length,
      selectedCandidates: selected.length,
    } : null,
    signalDateRange: {
      from: signalDates.sort()[0],
      to: signalDates.sort().at(-1),
    },
    accountDateRange: {
      from: dates[0],
      to: dates.at(-1),
    },
    scenarios,
  }
  const output = args['--output']
  if (output) {
    fs.writeFileSync(output, JSON.stringify(result, null, 2))
  }
  console.log(JSON.stringify({
    output: output ? path.resolve(output) : null,
    scenarios: Object.fromEntries(
      Object.entries(scenarios).map(([name, value]) => [
        name,
        {
          acceptedCount: value.acceptedCount,
          skippedCount: value.skipped.length,
          ...value.summary,
          accountState: undefined,
          audit: value.summary.audit,
        },
      ]),
    ),
  }, null, 2))
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main()
}
